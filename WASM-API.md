# Shopify Function Wasm API for JZ

## Goal

Make the Shopify Function wasm API a drop-in replacement for the current JZ
WASI JSON path.

End-user function authors should keep writing normal JavaScript:

```js
export function run(input) {
  const configuration =
    input?.deliveryCustomization?.configuration?.jsonValue ?? {}

  if (!configuration?.methods?.length || !input?.cart?.deliveryGroups?.length) {
    return { operations: [] }
  }

  return {
    operations: [
      {
        hide: {
          deliveryOptionHandle:
            input.cart.deliveryGroups[0].deliveryOptions[0].handle,
        },
      },
    ],
  }
}
```

The user-land contract is normal JS objects, arrays, strings, optional chaining,
property reads, array indexing, `length`, and plain returned objects. The
implementation may use generated build artifacts, shims, compiler lowering, and
runtime helpers, but the end-user source should not need to import a special SDK
or call explicit wasm API functions.

## What We Built

### JZ `shopify_function` host module

Added a low-level JZ module at `module/shopify_function.js` that imports
`shopify_function_v2` ABI functions and exposes helpers for:

- input root access
- object property lookup
- object key lookup
- array indexing
- value length
- scalar type checks
- number and boolean conversion
- input string materialization
- output object/array/scalar writing
- dynamic output strings

The module is intentionally low-level. It carries wasm API `Val` handles as raw
`f64` bit patterns inside JZ and emits calls to the ABI imports.

### Codegen `--language jz`

Added a JZ emitter to the local
`/Users/davidcameron/src/github.com/Shopify/shopify-function-wasm-api` branch.
The emitter generates `generated-wasm-api/schema.js` with:

- `readInput()`
- target-specific input reader aliases
- `writeResult()`
- target-specific result writer aliases
- output writers for GraphQL input object result types

For the prototype, `readInput()` materializes the selected GraphQL input into
the same object shape that existing Checkout Blocks JS/JZ code expects.
`writeResult()` writes the normal returned JS object through the wasm API output
builder.

### Checkout Blocks prototype

Modified `extensions/function-delivery-hide-cart-jz` to:

- add `extensions.build.typegen_command`
- generate `generated-wasm-api/schema.js`
- replace the JSON/WASI shim with:

```js
import { run as userRun } from '../src/run.js'
import { readInput, writeResult } from '../generated-wasm-api/schema.js'

export let run = () => {
  writeResult(userRun(readInput()))
}
```

`src/run.ts` was left unchanged.

The function builds successfully with:

```sh
shadowenv exec -- pnpm shopify app function build
```

The final built wasm imports the trampoline-facing `shopify_function_v2`
symbols and no WASI stdin/stdout imports.

## What We Learned

### Existing user-land cannot transparently use raw wasm API values today

The wasm API exposes lazy `Val` handles. Existing JS code expects normal object
and array semantics:

- `input.cart`
- `input?.cart?.deliveryGroups?.length`
- `deliveryGroups[0]`
- `array.map/filter/some/every`
- string methods on fields
- returned object literals

JZ does not currently have `Proxy`, classes are unsupported, and normal property
access does not know that a value is a wasm API handle. So raw handles cannot
simply be passed to unchanged user-land code.

### Shopify semantics should not live in JZ core

An early lazy-shape experiment tried to thread Shopify Function shape metadata
directly through JZ's normal property dispatch. That is too invasive. The core
`obj.prop`, `obj?.prop`, `arr[i]`, and `.length` paths are shared by all JZ
programs; hardcoding Shopify Function handle semantics there would make a
single integration leak into the general JavaScript lowering pipeline.

The right boundary is either:

- generated source that explicitly calls the low-level `shopify_function`
  helpers, or
- a small generic compiler extension point that lets modules/codegen claim
  property/index/length lowering for branded values.

In either case, the Shopify-specific logic belongs in the Shopify module and
generated SDK metadata, not in core dispatch itself.

The current next-version prototype follows this boundary:

- `ctx.core.lazyAccess` is a generic registry for module-owned lazy value hooks.
- JZ analysis tracks an opaque `lazy` representation on locals, params, and
  user-function return values.
- Core `.` / `?.` and array `[]` dispatch ask registered hooks whether they own
  the receiver; if no hook claims it, existing behavior is unchanged.
- `module/shopify_function.js` owns the Shopify shape interpretation and emits
  wasm-api calls for branded values.

This keeps core generic. The only core-level concept is "some module owns this
lazy value"; Shopify field semantics remain in the Shopify module/codegen.

### Materialization works but is not the target

The current generated JZ SDK reads wasm API handles and builds plain JZ objects.
That proves the ABI path and removes WASI JSON transport, but it is still eager:
fields selected by the input query are copied into JZ objects before user code
runs.

This is useful as a compatibility prototype, not the final design.

### Build scripts are acceptable; user-land changes are not

It is acceptable for a function extension to:

- run typegen
- generate SDK files
- compile through a custom build script
- use `shopify app function build` so the trampoline/multi-memory merge happens

It is not acceptable for merchants or app developers to rewrite function logic
against an explicit low-level SDK.

### Shopify CLI wasm-opt feature profile matters

The Shopify CLI build currently runs `wasm-opt` with a feature subset that does
not include tail calls or multivalue. JZ can emit both in some paths, especially
regex helpers and tail-call rewrites.

For the prototype we worked around this by:

- compiling with `noTailCall: true`
- narrowing helper modules to avoid regex/multivalue paths
- replacing host-only console/time behavior during build

That is prototype scaffolding. Long term, JZ should have a Shopify Function
target/profile that emits wasm compatible with the Shopify CLI optimization and
trampoline pipeline, or the extension config should explicitly disable wasm-opt
when appropriate.

### Performance improved, but not enough

Using the existing `function-delivery-hide-cart` benchmark fixture:

| Variant | Instructions | vs Rust | Wasm size |
| --- | ---: | ---: | ---: |
| Rust | 98,430 | 1.00x | 235 KB |
| JZ stdin/stdout JSON, historical raw | 186,625 | 1.90x | 137 KB |
| JZ wasm-api prototype | 157,058 | 1.60x | 67 KB |

The wasm API prototype is about 15.8% fewer instructions than the historical JZ
JSON/stdin/stdout path on this fixture, but still about 59.6% more instructions
than Rust.

The likely reason is that we removed JSON transport but still eagerly
materialize the input. Rust gets lazy field access from generated SDK accessors.
JZ needs the same idea behind normal JS syntax.

## Target Architecture

Use lazy object semantics for generated GraphQL input values.

At a high level:

```text
user code:
  input.cart.deliveryGroups[0].deliveryOptions.length

JZ lowered form:
  sf.arrayLen(
    sf.getObjProp(
      sf.getAtIndex(
        sf.getObjProp(
          sf.getObjProp(input_handle, "cart"),
          "deliveryGroups"
        ),
        0
      ),
      "deliveryOptions"
    )
  )
```

But the user should still write the first form.

The generated SDK should provide typed/lazy root values, and the JZ compiler
should lower known property/index/length reads against those lazy values to wasm
API calls.

## Proposed Lazy Semantics

### 1. Introduce a lazy value representation

Add a distinct internal value kind for Shopify Function wasm API values, for
example:

```js
VAL.SF_VALUE
```

This is not a normal JS object. It is a handle-backed value known to the
compiler.

The generated SDK can expose:

```js
export let readInput = () => sf.inputGet()
```

or a thin branded wrapper that the compiler recognizes as the query root.

### 2. Generate query shape metadata

The JZ codegen should emit static schema/query metadata that maps property
paths to expected field kinds:

```js
export const __sfShape = {
  cart: {
    kind: "object",
    fields: {
      deliveryGroups: {
        kind: "array",
        item: {
          kind: "object",
          fields: {
            deliveryOptions: {
              kind: "array",
              item: {
                kind: "object",
                fields: {
                  handle: { kind: "string" },
                  title: { kind: "nullable", of: { kind: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
}
```

This metadata does not need to exist as runtime data if the compiler can ingest
it during module preparation. The important part is that JZ knows which
properties on `input` are wasm API fields and what each read returns.

### 3. Lower property access on known lazy values

When the compiler sees:

```js
input.cart
```

and `input` is known as a Shopify Function lazy object, emit:

```js
sf.getObjProp(input, "cart")
```

The returned expression remains lazy and carries the child shape.

### 4. Lower optional chaining

When the compiler sees:

```js
input?.deliveryCustomization?.configuration?.jsonValue
```

against lazy values, emit null checks against wasm API tags:

```js
let v0 = input
if (sf.isNull(v0)) return null
let v1 = sf.getObjProp(v0, "deliveryCustomization")
if (sf.isNull(v1)) return null
let v2 = sf.getObjProp(v1, "configuration")
if (sf.isNull(v2)) return null
let v3 = sf.getObjProp(v2, "jsonValue")
```

For JSON scalar fields, either:

- materialize just that JSON subtree, or
- preserve it as a lazy JSON value and lower accesses into it too.

For Checkout Blocks configuration, lazy JSON access is important because
configuration can be large.

### 5. Lower array access and length

For lazy arrays:

```js
groups.length
groups[i]
```

emit:

```js
sf.arrayLen(groups)
sf.getAtIndex(groups, i)
```

The returned item keeps its generated item shape.

### 6. Lower common array combinators

Checkout Blocks shared code uses array helpers like:

- `map`
- `filter`
- `some`
- `every`
- `find`
- `reduce`
- `push`

For lazy input arrays, prefer compiler lowerings that iterate with
`sf.arrayLen` and `sf.getAtIndex` without materializing the array.

Examples:

```js
groups.some((group) => group.deliveryOptions.length)
```

should lower to a loop over lazy items.

This is where a large part of the Rust gap likely remains.

### 7. Lower scalar conversion only at use sites

For lazy scalar fields:

- string field read used as string -> `sf.readString(value)`
- number field read used as number -> `sf.asNumber(value)`
- boolean field read used as boolean -> `sf.asBool(value)`

Avoid reading strings just to store them in an intermediate object.

### 8. Write output directly

Returned object literals can either:

- keep using generated `writeResult(result)` for now, or
- be compiler-lowered directly to output builder calls when the return type is
  known.

The second option is faster but more complex. Input laziness should come first.

## Next Steps

### Step 1: Make the prototype less invasive

Create a Shopify Function compile profile in JZ:

```js
compile(src, {
  target: "shopify-function",
  host: "wasi",
  noTailCall: true,
  runtimeExports: false,
})
```

This profile should:

- enable the `shopify_function` module
- reject or rewrite host-only console/time behavior
- avoid tail-call output
- avoid multivalue output when Shopify CLI wasm-opt is enabled
- preserve compatibility with `shopify app function build`

This removes much of the current build-script source surgery.

### Step 2: Teach codegen to emit lazy root metadata

Change `--language jz` codegen from "materialize the full query" to "declare a
lazy root shape".

The generated file should ideally be small:

```js
import * as sf from "shopify_function"

export let readInput = () => sf.inputGet()
export let writeResult = ...
export const __jzShopifyFunctionShape = ...
```

### Step 3: Add a narrow compiler extension point

Do not hardcode Shopify Function behavior into `module/core.js`. Instead, use a
generic hook that modules can register, for example:

```js
ctx.core.lazyAccess.push({
  shapeOf(expr) { ... },
  emitProp(obj, prop) { ... },
  emitIndex(obj, idx) { ... },
  emitLength(obj) { ... },
})
```

The core property/index emitters would only ask registered hooks whether they
own a receiver. If no hook claims it, existing JZ behavior is unchanged.

The Shopify Function module/codegen can then track lazy shapes through:

- local bindings
- function parameters
- property reads
- optional property reads
- array index reads
- array helper callbacks

The key is that after:

```js
let groups = input.cart.deliveryGroups
```

the compiler knows `groups` is a lazy array of `CartDeliveryGroup`.

### Step 4: Lower lazy property/index/length reads in the Shopify hook

The Shopify hook should make normal syntax over lazy values produce wasm API
calls:

- `.` -> `sf.getObjProp`
- `?.` -> guarded `sf.getObjProp`
- `[]` -> `sf.getAtIndex`
- `.length` -> `sf.arrayLen` / `sf.stringLen` / `sf.objectLen`

Start with straight-line property/index/length access. This should already
remove most input materialization for simple functions.

### Step 5: Lower lazy JSON configuration access

Checkout Blocks stores rich configuration in `jsonValue`. If `jsonValue`
materializes eagerly, the big JSON cost remains.

Support lazy access into JSON scalar values:

```js
configuration.methods.length
configuration.methods[i].rules
```

using the same wasm API object/array operations. JSON fields can be treated as
dynamic lazy values when no precise JSON schema is available. If codegen gets
JSON override types later, those can become precise shapes.

### Step 6: Lower array combinators over lazy arrays

Implement lazy-array lowerings for the common methods in Checkout Blocks:

- `some`
- `every`
- `find`
- `filter`
- `map`
- `reduce`

For methods that return arrays (`filter`, `map`), decide case by case:

- if the result is immediately consumed by `.length`, `push(...result)`, or a
  loop, avoid materializing
- otherwise materialize a normal JZ array as an escape hatch

### Step 7: Benchmark after each lowering

Use `function-runner --json` with the existing fixtures.

Primary target:

```text
function-delivery-hide-cart
```

Track:

- Rust instruction count
- historical JZ JSON/WASI instruction count
- JZ wasm API materialized instruction count
- JZ wasm API lazy property/index/length
- JZ wasm API lazy JSON configuration
- JZ wasm API lazy array combinators

Success means getting close to Rust while keeping user-land code unchanged.

## Open Questions

### Should the lazy value be a true runtime value?

If lazy values only exist as compiler facts, user code that stores them in
dynamic containers may force materialization. That is probably acceptable as a
first version.

If we need lazy values to survive more dynamic patterns, JZ may need a real
runtime lazy wrapper representation. That is more complex and risks becoming a
partial `Proxy` implementation.

### How much dynamic JS should stay lazy?

Static property chains are straightforward. Dynamic keys are harder:

```js
input.cart[key]
```

Options:

- compile error in Shopify Function strict mode
- materialize the object
- use dynamic string key lookup if the key is known to be a string

The first pass should optimize static code and fall back conservatively.

Checkout Blocks scan results:

- The hot function code has one direct dynamic read from Shopify Function input:
  `input.cart[key]` in `extensions/function-core/rules.js`, used to collect
  `attribute1` and `attribute2` for cart attribute rules.
- Other dynamic reads are on normal JS/config/helper objects, not GraphQL input
  handles:
  - `attribute[property]` in `testAttributes`
  - `Rules[rule.type]`
  - `conversionFactors[key]`

So dynamic input property access is not common in Checkout Blocks today, but the
one case is important for cart attribute rules.

First-pass behavior should be:

- if the key can be proven to be one of a small static set, lower to a branch or
  loop over direct wasm API property calls
- otherwise materialize only that object/subtree and use normal dynamic property
  semantics
- avoid failing user-land code unless the Shopify Function target is running in
  an explicitly strict/debug mode

For the cart attribute case, this:

```js
const attributeKeys = ["attribute1", "attribute2"]
const attributes = attributeKeys
  .map((key) => input.cart[key])
  .filter((attr) => attr !== null)
```

can stay lazy by recognizing the constant key array and lowering the callback to
direct property reads of `attribute1` and `attribute2`.

### How should output lowering work?

Generated `writeResult()` is good enough initially. Direct return-object
lowering can come later after input laziness is proven.

### Should wasm-opt be disabled?

Disabling wasm-opt is useful for experiments, especially while JZ still emits
tail calls or multivalue in some helper paths. Long term, the Shopify Function
target should either emit the accepted feature subset or explicitly configure
the extension build so the artifact is accepted without manual intervention.

## Removing Prototype Stubbing

The current Checkout Blocks prototype uses build-time source cleanup for
host-only behavior and helper paths that cause incompatible wasm features. This
is acceptable for measurement, but not for the final drop-in story.

Removal plan:

1. Add a first-class JZ Shopify Function target/profile.
   - no tail calls by default
   - no multivalue by default when Shopify CLI wasm-opt is enabled
   - no WASI stdin/stdout unless explicitly requested
   - no host console/time imports

2. Replace console/time stubbing with compile-profile behavior.
   - `console.log/warn/error` should either lower to Shopify function logging
     when supported or no-op in production profile
   - `Date.now()` should be rejected, lowered from an available input field, or
     no-op only under an explicit compatibility flag

3. Replace helper-module stubbing with feature-compatible JZ implementations.
   - regex helpers should avoid multivalue or be gated out when unused
   - array/string helpers should avoid tail-call-only forms under this profile

4. Move narrow helper imports into codegen/compiler reachability instead of
   handwritten build scripts.
   - The compiler should include only helper paths reachable from the bundled
     user function.
   - If a helper path is unreachable from the generated query/config shapes, it
     should not affect the wasm feature set.

5. Keep materialization as a semantic fallback, not as the primary path.
   - Dynamic or escaping lazy values can materialize subtrees.
   - Static property chains, JSON config paths, and common array combinators
     should remain lazy.

## Current Pause Point: 2026-05-09

### What is working now

- JZ has a generic lazy hook boundary. Core asks the lazy value's owner hook to
  lower property, index, length, and method operations; Shopify-specific wasm API
  behavior lives in `module/shopify_function.js`.
- Lazy hook branding no longer uses a string name lookup like
  `name === "shopify_function"`. Lazy reps carry the module hook object.
- `shopify_function.lazyInput(shape)` can expose normal JS syntax for lazy
  property/index/length chains:

```js
input.cart.lines[1].quantity
input?.deliveryCustomization?.configuration
input.cart.lines.length
```

- Lazy array method lowering exists for the Shopify hook for:
  - `some`
  - `every`
  - `find`
  - `forEach`
  - `map`
  - `filter`
- Callback parameters in those lazy array methods carry the lazy item shape, so
  expressions like `line.quantity > 1` still lower to wasm API calls.
- Expression-bodied callbacks and simple block-bodied callbacks with `return`
  are covered by focused tests.
- `??` now preserves the left-hand lazy fact, which matches Checkout Blocks'
  common pattern:

```js
const configuration =
  input?.deliveryCustomization?.configuration?.jsonValue ?? {}
```

### Typed `jsonValue`

Rust is not truly lazy for arbitrary `jsonValue` in this Checkout Blocks target.
It uses a custom scalar override:

```rust
"RunInput.deliveryCustomization.configuration.jsonValue" => super::run::Configuration
```

For JZ, the equivalent should be build/codegen metadata, not a user-land source
change. The wasm API codegen already supports this through:

```sh
--json-types json_types.graphql
--json-override deliveryCustomization.configuration.jsonValue=Configuration
```

Note the override key is suffix-matched against query field paths. The
Rust-style full root path with `RunInput.` did not match in the JS codegen.

For the experiment, `function-delivery-hide-cart-jz` now has a supplementary
`json_types.graphql` that describes:

```graphql
type Configuration {
  methods: [ConfigMethod!]
}
```

and the generated JZ shape correctly turns `jsonValue` into a typed object with
`methods`, `name`, `rgx`, `rules`, `when`, and basic rule fields.

This is still build metadata. It does not require changing `src/run.ts`.

### Latest benchmark result

After rebuilding with `shopify app function build` so the trampoline is applied:

```text
rust:                     98,430 instructions, correct output
jz-wasi-json-historical: 186,625 instructions, correct output
jz-wasi-json-compatible:  83,729 instructions, correct output
jz-wasm-api:               7,390 instructions, incorrect output: operations []
```

The low instruction count is not a success yet. The output is still wrong.

The final trampoline-merged wasm imports:

```text
_shopify_function_input_get
_shopify_function_input_get_obj_prop
_shopify_function_input_get_val_len
```

but it does not import:

```text
_shopify_function_input_get_at_index
```

That means the real Checkout Blocks path is still not reaching lazy array
iteration, even though the focused JZ tests do.

### Current blocker

The remaining blocker is lazy fact propagation through normal object
construction and destructured parameters.

Checkout Blocks calls:

```js
generateHideChanges({
  methods: configuration.methods,
  input,
})
```

and the callee is:

```js
export function generateHideChanges({ methods, input }) {
  // ...
}
```

`configuration.methods` is lazy at the call site, but it is stored into a normal
object literal and then recovered through destructuring. JZ currently loses the
lazy metadata at that boundary, so `methods` inside `generateHideChanges` is no
longer known to be a lazy Shopify array. Because of that, the lazy array method
hook does not fire in the real function.

This should still be fixed in compiler/codegen, not by changing end-user source.
Possible fixes:

1. Propagate lazy property facts through direct object-literal arguments.
   - Detect direct calls like `fn({ methods: lazyArray, input: lazyInput })`.
   - Seed destructured callee params with the corresponding lazy facts.
   - This is likely the best next step for the drop-in story.

2. Preserve property-level lazy metadata on object literals.
   - A normal JZ object could carry schema facts saying property `methods` is a
     lazy Shopify value.
   - Destructuring and `.methods` reads would recover that fact.
   - This is more general but touches more compiler surface.

3. Build-time rewrite as a proof only.
   - Rewrite `generateHideChanges({ methods, input })` to
     `generateHideChanges(methods, input)`.
   - This would prove the rest of the lazy lowering, but it is not the desired
     long-term approach because it shapes user-land code.

### Build note

`shopify app function build` appeared to hang when run silently. Running it with
CI mode, verbose logging, and a timeout completed quickly:

```sh
/opt/homebrew/bin/timeout 45s env CI=1 SHOPIFY_CLI_NO_ANALYTICS=1 \
  pnpm shopify app function build --verbose
```

The build itself is not the current bottleneck.
