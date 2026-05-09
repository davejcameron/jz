#!/usr/bin/env node
/**
 * WAT audit — compile a JZ source file and surface missed optimisation
 * opportunities and stdlib bloat in the optimized output.
 *
 * Anti-pattern checks flag constructs that a JZ optimisation pass is
 * supposed to eliminate. A non-zero count means the pass has a missed case.
 *
 * Usage:
 *   node scripts/wat-audit.mjs <file.js> [--opt=0|1|2|3] [--verbose]
 *
 * Examples:
 *   node scripts/wat-audit.mjs bench/biquad/biquad.js
 *   node scripts/wat-audit.mjs src/mymodule.js --opt=1 --verbose
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '../index.js'

const ROOT  = dirname(dirname(fileURLToPath(import.meta.url)))
const BENCH = join(ROOT, 'bench')
const LIB   = join(BENCH, '_lib')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const inputFile = args.find(a => !a.startsWith('--'))
const optLevel  = Number((args.find(a => a.startsWith('--opt=')) ?? '--opt=2').slice(6))
const verbose   = args.includes('--verbose') || args.includes('-v')

if (!inputFile || !existsSync(resolve(inputFile))) {
  console.error('Usage: node scripts/wat-audit.mjs <file.js> [--opt=0|1|2|3] [--verbose]')
  process.exit(1)
}

const absInput = resolve(inputFile)
const src      = readFileSync(absInput, 'utf8')
const name     = basename(absInput)

// ---------------------------------------------------------------------------
// Bench program detection — supply modules bench programs depend on
// ---------------------------------------------------------------------------

function benchOptionsFor(file) {
  const rel = relative(BENCH, file)
  // Only apply if the file is directly inside bench/<case>/<case>.js
  if (!rel || rel.startsWith('..') || rel.split('/').length !== 2) return {}

  const caseId = rel.split('/')[0]

  const benchlibSrc = readFileSync(join(LIB, 'benchlib.js'), 'utf8')
    .replace(
      `export let printResult = (medianUs, checksum, samples, stages, runs) => {
  console.log(\`median_us=\${medianUs} checksum=\${checksum} samples=\${samples} stages=\${stages} runs=\${runs}\`)
}`,
      `export let printResult = (medianUs, checksum, samples, stages, runs) => {
  env.logResult(medianUs, checksum, samples, stages, runs)
}`
    )

  const watrModules = caseId === 'watr' ? {
    './watr-compile.js': `import compileWatr from '../../node_modules/watr/src/compile.js'\nexport const compile = (src) => compileWatr(src)\n`,
    '../../node_modules/watr/src/compile.js': readFileSync(join(ROOT, 'node_modules/watr/src/compile.js'), 'utf8'),
    './encode.js': readFileSync(join(ROOT, 'node_modules/watr/src/encode.js'), 'utf8'),
    './const.js':  readFileSync(join(ROOT, 'node_modules/watr/src/const.js'),  'utf8'),
    './parse.js':  readFileSync(join(ROOT, 'node_modules/watr/src/parse.js'),  'utf8'),
    './util.js':   readFileSync(join(ROOT, 'node_modules/watr/src/util.js'),   'utf8'),
  } : {}

  return {
    modules: { '../_lib/benchlib.js': benchlibSrc, ...watrModules },
    imports: {
      env: { logResult: { params: 5 } },
      performance: { now: { params: 0, returns: 'number' } },
    },
    alloc: false,
    ...(caseId === 'watr' ? { jzify: true, memoryPages: 4096 } : {}),
  }
}

const extraOpts = benchOptionsFor(absInput)

// Compile at the target level and level 0 for before/after comparison.
// Level 0 shows what the emitter produces before any optimiser touches it.
const watOpt = compile(src, { wat: true, optimize: optLevel, ...extraOpts })
const wat0   = compile(src, { wat: true, optimize: 0,        ...extraOpts })

// ---------------------------------------------------------------------------
// WAT helpers
// ---------------------------------------------------------------------------

function count(wat, re) {
  return (wat.match(re) || []).length
}

/** Extract named func nodes from WAT text using balanced-paren scanning. */
function extractFuncs(wat) {
  const funcs = []
  // WAT identifiers: $followed by any non-whitespace non-paren chars.
  // Also matches (func (export ...) anonymous export forms.
  const funcRe = /\(func\s+(\$[^\s()]+|\(export)/g
  let m
  while ((m = funcRe.exec(wat)) !== null) {
    const funcName = m[1]
    const start    = m.index
    let depth = 0, i = start
    while (i < wat.length) {
      if (wat[i] === '(')      depth++
      else if (wat[i] === ')') { if (--depth === 0) break }
      i++
    }
    funcs.push({ name: funcName, body: wat.slice(start, i + 1) })
  }
  return funcs
}

/** WAT text containing only user-authored functions (non-stdlib). */
function userWat(wat) {
  return extractFuncs(wat)
    .filter(f => !f.name.startsWith('$__'))
    .map(f => f.body)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Anti-pattern definitions
// ---------------------------------------------------------------------------
// Each entry: [id, description, scoped, regex, hint]
//   scoped: true  → check only user-function bodies (not stdlib internals)
//           false → check full WAT

const CHECKS = [
  [
    'rebox-f64-i64',
    'f64→i64→f64 rebox cycle',
    false,
    /f64\.reinterpret_i64\s*\(\s*i64\.reinterpret_f64/g,
    'fusedRewrite should cancel these round-trip reinterprets to a no-op',
  ],
  [
    'rebox-i64-f64',
    'i64→f64→i64 rebox cycle',
    false,
    /i64\.reinterpret_f64\s*\(\s*f64\.reinterpret_i64/g,
    'fusedRewrite should cancel these round-trip reinterprets to a no-op',
  ],
  [
    'const-convert',
    'f64.convert_i32_s on i32.const',
    false,
    /f64\.convert_i32_s\s*\(\s*i32\.const/g,
    'constant folding should replace with a literal f64.const at compile time',
  ],
  [
    'mul-pow2',
    'i32.mul by power-of-2 literal',
    false,
    /i32\.mul[\s\S]{0,120}?i32\.const\s+(?:2|4|8|16|32|64)\b/g,
    'fusedRewrite should convert to i32.shl (one cycle cheaper on all targets)',
  ],
  [
    'memory-size-mul',
    'memory.size × 65536',
    false,
    /i32\.mul\s*\(\s*memory\.size/g,
    'fusedRewrite should convert to (i32.shl (memory.size) (i32.const 16))',
  ],
  [
    'is-truthy-on-cmp',
    '__is_truthy wrapping a comparison',
    false,
    /call \$__is_truthy\s*\(\s*i64\.extend_i32_u\s*\(\s*i32\.[a-z_]+/g,
    'boolean propagation: comparison result is already 0/1, __is_truthy is redundant',
  ],
  [
    'dyn-get',
    '__dyn_get in user code (dynamic property read)',
    true,
    /call \$__dyn_get\b/g,
    'type inference missed the receiver — annotate its type or use a typed array',
  ],
  [
    'dyn-set',
    '__dyn_set in user code (dynamic property write)',
    true,
    /call \$__dyn_set\b/g,
    'type inference missed the receiver — annotate its type or use a typed array',
  ],
  [
    'to-num',
    '__to_num in user code (runtime number coercion)',
    true,
    /call \$__to_num\b/g,
    'value type should be statically known as numeric; check the expression producing it',
  ],
  [
    'ptr-type',
    '__ptr_type surviving in user code',
    true,
    /call \$__ptr_type\b/g,
    'hoistPtrType/fusedRewrite should have inlined or CSE\'d this type-tag extraction',
  ],
]

// ---------------------------------------------------------------------------
// Stdlib inventory
// ---------------------------------------------------------------------------

function stdlibInventory(wat) {
  const funcs = extractFuncs(wat)
  const stdlib = funcs.filter(f => f.name.startsWith('$__'))
  const result = stdlib.map(({ name, body }) => {
    const callCount = count(wat, new RegExp(`call\\s+\\${name}\\b`, 'g'))
    return { name, chars: body.length, callCount }
  })
  return result.sort((a, b) => b.chars - a.chars)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const C = {
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  grey:   '\x1b[90m',
  bold:   '\x1b[1m',
  reset:  '\x1b[0m',
}
const tick  = `${C.green}✓${C.reset}`
const cross = `${C.red}✗${C.reset}`

function fmtCount(n) {
  return n === 1 ? '1 occurrence' : `${n} occurrences`
}

// ---------------------------------------------------------------------------
// Run checks
// ---------------------------------------------------------------------------

const userOnly0   = userWat(wat0)
const userOnlyOpt = userWat(watOpt)

console.log(`\n${C.bold}WAT Audit: ${name}${C.reset}  (optimize: ${optLevel})\n`)
console.log(`${C.bold}Anti-patterns in optimized output:${C.reset}`)

let totalMissed = 0

for (const [, desc, scoped, re, hint] of CHECKS) {
  const src0   = scoped ? userOnly0   : wat0
  const srcOpt = scoped ? userOnlyOpt : watOpt

  const n0   = count(src0,   re)
  const nOpt = count(srcOpt, re)

  if (nOpt > 0) {
    totalMissed += nOpt
    const eliminated = n0 - nOpt
    const delta = n0 > 0
      ? `${C.grey} (${eliminated} of ${n0} eliminated)${C.reset}`
      : ''
    console.log(`  ${cross} ${desc.padEnd(44)} ${C.red}${fmtCount(nOpt)}${C.reset}${delta}`)
    if (verbose) console.log(`      ${C.grey}→ ${hint}${C.reset}`)
  } else if (n0 > 0) {
    console.log(`  ${tick} ${desc.padEnd(44)} ${C.grey}all ${n0} eliminated${C.reset}`)
  } else {
    console.log(`  ${tick} ${desc.padEnd(44)} ${C.grey}none${C.reset}`)
  }
}

if (totalMissed === 0) {
  console.log(`\n  ${C.green}No missed optimisations detected.${C.reset}`)
} else {
  console.log(`\n  ${C.red}${fmtCount(totalMissed)} across ${totalMissed === 1 ? '1 check' : 'multiple checks'}.${C.reset}`)
  if (!verbose) console.log(`  ${C.grey}Run with --verbose for hints on each.${C.reset}`)
}

// ---------------------------------------------------------------------------
// Stdlib inventory
// ---------------------------------------------------------------------------

const inventory = stdlibInventory(watOpt)
const allFuncs  = extractFuncs(watOpt)
const userFuncs = allFuncs.filter(f => !f.name.startsWith('$__'))

const stdlibChars = inventory.reduce((s, f) => s + f.chars, 0)
const userChars   = userFuncs.reduce((s, f) => s + f.body.length, 0)
const totalChars  = watOpt.length

console.log(`\n${C.bold}Stdlib pulled in (${inventory.length} functions):${C.reset}`)

if (inventory.length === 0) {
  console.log(`  ${C.grey}none${C.reset}`)
} else {
  console.log(`  ${'function'.padEnd(28)}  ${'WAT chars'.padStart(10)}  ${'call sites'.padStart(10)}`)
  console.log(`  ${'─'.repeat(28)}  ${'─'.repeat(10)}  ${'─'.repeat(10)}`)
  for (const { name, chars, callCount } of inventory) {
    const inlineHint = callCount <= 1
      ? ` ${C.yellow}← inline candidate${C.reset}`
      : ''
    console.log(
      `  ${name.padEnd(28)}  ${String(chars).padStart(10)}  ${String(callCount).padStart(10)}${inlineHint}`
    )
  }
}

const pct = (n, total) => `${Math.round(100 * n / total)}%`
console.log(`\n${C.bold}WAT size breakdown:${C.reset}`)
console.log(`  stdlib   ${String(stdlibChars).padStart(8)} chars  (${pct(stdlibChars, totalChars)} of total)`)
console.log(`  user     ${String(userChars).padStart(8)} chars  (${pct(userChars, totalChars)} of total)`)
console.log(`  total    ${String(totalChars).padStart(8)} chars`)
console.log()
