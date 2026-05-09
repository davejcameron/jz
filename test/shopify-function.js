// Shopify Function Wasm API bindings
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { compile } from '../index.js'

const SF_NAN_MASK = 0x7FFC000000000000n
const SF_TAG_OBJECT = 4n
const SF_TAG_ARRAY = 5n
const SF_TAG_STRING = 3n
const SF_TAG_NULL = 0n

const enc = (tag, ptr, len = 0) =>
  SF_NAN_MASK | (tag << 46n) | (BigInt(len) << 32n) | BigInt(ptr)

const obj = (id, len = 0) => enc(SF_TAG_OBJECT, id, len)
const arr = (id, len = 0) => enc(SF_TAG_ARRAY, id, len)
const str = (id, len = 0) => enc(SF_TAG_STRING, id, len)
const sfNull = () => enc(SF_TAG_NULL, 0, 0)

const f64bits = (n) => {
  const buf = new ArrayBuffer(8)
  new DataView(buf).setFloat64(0, n, true)
  return new DataView(buf).getBigInt64(0, true)
}

const source = `
  import * as sf from 'shopify_function'

  export let _start = () => {
    let input = sf.inputGet()
    let cart = sf.getObjProp(input, 'cart')
    let lines = sf.getObjProp(cart, 'lines')
    let hasError = 0

    if (sf.isArray(lines)) {
      let len = sf.arrayLen(lines)
      for (let i = 0; i < len; i++) {
        let line = sf.getAtIndex(lines, i)
        if (sf.isObject(line)) {
          let quantity = sf.getObjProp(line, 'quantity')
          if (sf.isNumber(quantity)) {
            if (sf.asNumber(quantity) > 1) hasError = 1
          }
        }
      }
    }

    sf.outputObject(1)
    sf.outputString('errors')
    if (hasError) {
      sf.outputArray(1)
      sf.outputObject(2)
      sf.outputString('localizedMessage')
      sf.outputString('Not possible to order more than one of each')
      sf.outputString('target')
      sf.outputString('$.cart')
      sf.outputFinishObject()
      sf.outputFinishArray()
    } else {
      sf.outputArray(0)
      sf.outputFinishArray()
    }
    sf.outputFinishObject()
  }
`

test('shopify_function: compiles to shopify_function_v2 imports without WASI JSON', () => {
  const mod = new WebAssembly.Module(compile(source, { host: 'wasi', runtimeExports: false }))
  const imports = WebAssembly.Module.imports(mod).map(i => `${i.module}.${i.name}`).sort()
  ok(imports.includes('shopify_function_v2.shopify_function_input_get'), imports.join('\n'))
  ok(imports.includes('shopify_function_v2.shopify_function_input_get_obj_prop'), imports.join('\n'))
  ok(imports.includes('shopify_function_v2.shopify_function_output_new_object'), imports.join('\n'))
  ok(!imports.some(i => i.startsWith('wasi_snapshot_preview1.')), imports.join('\n'))
})

test('shopify_function: lazy input read and direct output write', () => {
  const mod = new WebAssembly.Module(compile(source, { host: 'wasi', runtimeExports: false }))
  let memory
  const names = (ptr, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
  const output = []

  const imports = {
    shopify_function_v2: {
      shopify_function_input_get: () => obj(1, 1),
      shopify_function_input_get_val_len: (scope) => scope === arr(3, 2) ? 2 : 0,
      shopify_function_input_get_obj_prop: (scope, ptr, len) => {
        const name = names(ptr, len)
        if (scope === obj(1, 1) && name === 'cart') return obj(2, 1)
        if (scope === obj(2, 1) && name === 'lines') return arr(3, 2)
        if (scope === obj(4, 1) && name === 'quantity') return f64bits(1)
        if (scope === obj(5, 1) && name === 'quantity') return f64bits(2)
        return 0n
      },
      shopify_function_input_get_at_index: (scope, index) => {
        if (scope === arr(3, 2) && index === 0) return obj(4, 1)
        if (scope === arr(3, 2) && index === 1) return obj(5, 1)
        return 0n
      },
      shopify_function_input_get_interned_obj_prop: () => 0n,
      shopify_function_intern_utf8_str: () => 0,
      shopify_function_output_new_bool: (v) => output.push(['bool', v]) && 0,
      shopify_function_output_new_null: () => output.push(['null']) && 0,
      shopify_function_output_new_i32: (v) => output.push(['i32', v]) && 0,
      shopify_function_output_new_f64: (v) => output.push(['f64', v]) && 0,
      shopify_function_output_new_utf8_str: (ptr, len) => output.push(['str', names(ptr, len)]) && 0,
      shopify_function_output_new_interned_utf8_str: (id) => output.push(['istr', id]) && 0,
      shopify_function_output_new_object: (len) => output.push(['object', len]) && 0,
      shopify_function_output_finish_object: () => output.push(['endObject']) && 0,
      shopify_function_output_new_array: (len) => output.push(['array', len]) && 0,
      shopify_function_output_finish_array: () => output.push(['endArray']) && 0,
    },
  }
  const inst = new WebAssembly.Instance(mod, imports)
  memory = inst.exports.memory
  inst.exports._start()

  is(JSON.stringify(output), JSON.stringify([
    ['object', 1],
    ['str', 'errors'],
    ['array', 1],
    ['object', 2],
    ['str', 'localizedMessage'],
    ['str', 'Not possible to order more than one of each'],
    ['str', 'target'],
    ['str', '$.cart'],
    ['endObject'],
    ['endArray'],
    ['endObject'],
  ]))
})

test('shopify_function: hook lowers normal property/index/length syntax on lazy input', () => {
  const shape = JSON.stringify({
    kind: 'object',
    fields: {
      cart: {
        kind: 'object',
        fields: {
          lines: {
            kind: 'array',
            item: {
              kind: 'object',
              fields: {
                quantity: { kind: 'number' },
              },
            },
          },
        },
      },
    },
  })
  const mod = new WebAssembly.Module(compile(`
    import * as sf from 'shopify_function'
    let readInput = () => sf.lazyInput('${shape.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
    export let calc = () => {
      let input = readInput()
      return input.cart.lines[1].quantity + input.cart.lines.length
    }
  `, { host: 'wasi', runtimeExports: false }))

  let memory
  const names = (ptr, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
  const imports = {
    shopify_function_v2: {
      shopify_function_input_get: () => obj(1, 1),
      shopify_function_input_get_val_len: () => 0,
      shopify_function_input_read_utf8_str: () => {},
      shopify_function_input_get_obj_prop: (scope, ptr, len) => {
        const name = names(ptr, len)
        if (scope === obj(1, 1) && name === 'cart') return obj(2, 1)
        if (scope === obj(2, 1) && name === 'lines') return arr(3, 2)
        if (scope === obj(5, 1) && name === 'quantity') return f64bits(2)
        return 0n
      },
      shopify_function_input_get_at_index: (scope, index) => {
        if (scope === arr(3, 2) && index === 1) return obj(5, 1)
        return 0n
      },
      shopify_function_input_get_obj_key_at_index: () => str(0, 0),
      shopify_function_input_get_interned_obj_prop: () => 0n,
      shopify_function_intern_utf8_str: () => 0,
      shopify_function_output_new_bool: () => 0,
      shopify_function_output_new_null: () => 0,
      shopify_function_output_new_i32: () => 0,
      shopify_function_output_new_f64: () => 0,
      shopify_function_output_new_utf8_str: () => 0,
      shopify_function_output_new_interned_utf8_str: () => 0,
      shopify_function_output_new_object: () => 0,
      shopify_function_output_finish_object: () => 0,
      shopify_function_output_new_array: () => 0,
      shopify_function_output_finish_array: () => 0,
    },
  }
  const inst = new WebAssembly.Instance(mod, imports)
  memory = inst.exports.memory
  is(inst.exports.calc(), 4)
})

test('shopify_function: hook lowers optional property syntax on lazy input', () => {
  const shape = JSON.stringify({
    kind: 'object',
    fields: {
      deliveryCustomization: {
        kind: 'object',
        nullable: true,
        fields: {
          title: { kind: 'string', nullable: true },
        },
      },
    },
  })
  const mod = new WebAssembly.Module(compile(`
    import * as sf from 'shopify_function'
    let readInput = () => sf.lazyInput('${shape.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
    export let calc = () => {
      let input = readInput()
      return input?.deliveryCustomization?.title == null ? 7 : 1
    }
  `, { host: 'wasi', runtimeExports: false }))

  let memory
  const names = (ptr, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
  const imports = {
    shopify_function_v2: {
      shopify_function_input_get: () => obj(1, 1),
      shopify_function_input_get_val_len: () => 0,
      shopify_function_input_read_utf8_str: () => {},
      shopify_function_input_get_obj_prop: (scope, ptr, len) => {
        const name = names(ptr, len)
        if (scope === obj(1, 1) && name === 'deliveryCustomization') return sfNull()
        return sfNull()
      },
      shopify_function_input_get_at_index: () => sfNull(),
      shopify_function_input_get_obj_key_at_index: () => str(0, 0),
      shopify_function_input_get_interned_obj_prop: () => 0n,
      shopify_function_intern_utf8_str: () => 0,
      shopify_function_output_new_bool: () => 0,
      shopify_function_output_new_null: () => 0,
      shopify_function_output_new_i32: () => 0,
      shopify_function_output_new_f64: () => 0,
      shopify_function_output_new_utf8_str: () => 0,
      shopify_function_output_new_interned_utf8_str: () => 0,
      shopify_function_output_new_object: () => 0,
      shopify_function_output_finish_object: () => 0,
      shopify_function_output_new_array: () => 0,
      shopify_function_output_finish_array: () => 0,
    },
  }
  const inst = new WebAssembly.Instance(mod, imports)
  memory = inst.exports.memory
  is(inst.exports.calc(), 7)
})

test('shopify_function: lazy array expression callbacks keep item access lazy', () => {
  const shape = JSON.stringify({
    kind: 'object',
    fields: {
      cart: {
        kind: 'object',
        fields: {
          lines: {
            kind: 'array',
            item: {
              kind: 'object',
              fields: {
                quantity: { kind: 'number' },
              },
            },
          },
        },
      },
    },
  })
  const mod = new WebAssembly.Module(compile(`
    import * as sf from 'shopify_function'
    let readInput = () => sf.lazyInput('${shape.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
    export let hasLarge = () => readInput().cart.lines.some(line => line.quantity > 1) ? 9 : 3
    export let filteredLen = () => readInput().cart.lines.filter(line => line.quantity > 1).length
    export let mappedValue = () => readInput().cart.lines.map(line => line.quantity + 10)[1]
  `, { host: 'wasi', runtimeExports: false }))

  let memory
  const names = (ptr, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
  const imports = {
    shopify_function_v2: {
      shopify_function_input_get: () => obj(1, 1),
      shopify_function_input_get_val_len: () => 0,
      shopify_function_input_read_utf8_str: () => {},
      shopify_function_input_get_obj_prop: (scope, ptr, len) => {
        const name = names(ptr, len)
        if (scope === obj(1, 1) && name === 'cart') return obj(2, 1)
        if (scope === obj(2, 1) && name === 'lines') return arr(3, 2)
        if (scope === obj(4, 1) && name === 'quantity') return f64bits(1)
        if (scope === obj(5, 1) && name === 'quantity') return f64bits(2)
        return sfNull()
      },
      shopify_function_input_get_at_index: (scope, index) => {
        if (scope === arr(3, 2) && index === 0) return obj(4, 1)
        if (scope === arr(3, 2) && index === 1) return obj(5, 1)
        return sfNull()
      },
      shopify_function_input_get_obj_key_at_index: () => str(0, 0),
      shopify_function_input_get_interned_obj_prop: () => 0n,
      shopify_function_intern_utf8_str: () => 0,
      shopify_function_output_new_bool: () => 0,
      shopify_function_output_new_null: () => 0,
      shopify_function_output_new_i32: () => 0,
      shopify_function_output_new_f64: () => 0,
      shopify_function_output_new_utf8_str: () => 0,
      shopify_function_output_new_interned_utf8_str: () => 0,
      shopify_function_output_new_object: () => 0,
      shopify_function_output_finish_object: () => 0,
      shopify_function_output_new_array: () => 0,
      shopify_function_output_finish_array: () => 0,
    },
  }
  const inst = new WebAssembly.Instance(mod, imports)
  memory = inst.exports.memory
  is(inst.exports.hasLarge(), 9)
  is(inst.exports.filteredLen(), 1)
  is(inst.exports.mappedValue(), 12)
})

test('shopify_function: lazy array block callbacks keep item access lazy', () => {
  const shape = JSON.stringify({
    kind: 'object',
    fields: {
      cart: {
        kind: 'object',
        fields: {
          lines: {
            kind: 'array',
            item: {
              kind: 'object',
              fields: {
                quantity: { kind: 'number' },
              },
            },
          },
        },
      },
    },
  })
  const mod = new WebAssembly.Module(compile(`
    import * as sf from 'shopify_function'
    let readInput = () => sf.lazyInput('${shape.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')
    export let filteredLen = () => readInput().cart.lines.filter(line => {
      if (line.quantity > 1) return true
      return false
    }).length
    export let mappedValue = () => readInput().cart.lines.map(line => {
      if (line.quantity > 1) return line.quantity + 10
      return 0
    })[1]
  `, { host: 'wasi', runtimeExports: false }))

  let memory
  const names = (ptr, len) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
  const imports = {
    shopify_function_v2: {
      shopify_function_input_get: () => obj(1, 1),
      shopify_function_input_get_val_len: () => 0,
      shopify_function_input_read_utf8_str: () => {},
      shopify_function_input_get_obj_prop: (scope, ptr, len) => {
        const name = names(ptr, len)
        if (scope === obj(1, 1) && name === 'cart') return obj(2, 1)
        if (scope === obj(2, 1) && name === 'lines') return arr(3, 2)
        if (scope === obj(4, 1) && name === 'quantity') return f64bits(1)
        if (scope === obj(5, 1) && name === 'quantity') return f64bits(2)
        return sfNull()
      },
      shopify_function_input_get_at_index: (scope, index) => {
        if (scope === arr(3, 2) && index === 0) return obj(4, 1)
        if (scope === arr(3, 2) && index === 1) return obj(5, 1)
        return sfNull()
      },
      shopify_function_input_get_obj_key_at_index: () => str(0, 0),
      shopify_function_input_get_interned_obj_prop: () => 0n,
      shopify_function_intern_utf8_str: () => 0,
      shopify_function_output_new_bool: () => 0,
      shopify_function_output_new_null: () => 0,
      shopify_function_output_new_i32: () => 0,
      shopify_function_output_new_f64: () => 0,
      shopify_function_output_new_utf8_str: () => 0,
      shopify_function_output_new_interned_utf8_str: () => 0,
      shopify_function_output_new_object: () => 0,
      shopify_function_output_finish_object: () => 0,
      shopify_function_output_new_array: () => 0,
      shopify_function_output_finish_array: () => 0,
    },
  }
  const inst = new WebAssembly.Instance(mod, imports)
  memory = inst.exports.memory
  is(inst.exports.filteredLen(), 1)
  is(inst.exports.mappedValue(), 12)
})
