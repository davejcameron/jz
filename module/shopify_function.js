/**
 * Shopify Function Wasm API bindings.
 *
 * This module is deliberately low-level: it mirrors the ABI from
 * shopify_function_v2 and carries input `Val` handles as raw f64 bit patterns
 * inside JZ. Callers should use these helpers instead of normal JS property
 * access on API values.
 *
 * @module shopify_function
 */

import { typed, asF64, asI32, asI64, temp, tempI32, tempI64, nullExpr, undefExpr, truthyIR, allocPtr, elemStore } from '../src/ir.js'
import { emit, emitFlat } from '../src/emit.js'
import { err, inc, PTR } from '../src/ctx.js'
import { extractParams, updateRep } from '../src/analyze.js'

const MOD = 'shopify_function_v2'

const SF_NAN_MASK = '0x7FFC000000000000'
const SF_TAG_MASK = '0x0003C00000000000'
const SF_VALUE_MASK = '0x00003FFFFFFFFFFF'
const SF_POINTER_MASK = '0x00000000FFFFFFFF'
const SF_TAG_SHIFT = 46
const SF_VALUE_ENCODING_SIZE = 32
const SF_MAX_VALUE_LENGTH = 16383

const SF_TAG_NULL = 0
const SF_TAG_BOOL = 1
const SF_TAG_NUMBER = 2
const SF_TAG_STRING = 3
const SF_TAG_OBJECT = 4
const SF_TAG_ARRAY = 5

const addImportOnce = (ctx, name, fn) => {
  if (ctx.module.imports.some(i => i[1] === `"${MOD}"` && i[2] === `"${name}"`)) return
  ctx.module.imports.push(['import', `"${MOD}"`, `"${name}"`, fn])
}

const literalString = (node, api) => {
  if (Array.isArray(node) && node[0] === 'str' && typeof node[1] === 'string') return node[1]
  if (Array.isArray(node) && node[0] == null && typeof node[1] === 'string') return node[1]
  err(`shopify_function.${api} currently requires a string literal`)
}

const staticUtf8 = (ctx, str) => {
  if (ctx.memory.shared) err('shopify_function string literals require own memory for now')
  const key = `sf:${str}`
  const prior = ctx.runtime.dataDedup.get(key)
  const bytes = new TextEncoder().encode(str)
  const ptrNode = (ptr) => {
    const n = ['i32.const', ptr]
    n.staticDataOffset = true
    return n
  }
  if (prior !== undefined) return { ptr: ptrNode(prior), len: bytes.length }
  if (!ctx.runtime.data) ctx.runtime.data = ''
  while (ctx.runtime.data.length % 4 !== 0) ctx.runtime.data += '\0'
  const ptr = ctx.runtime.data.length
  for (let i = 0; i < bytes.length; i++) ctx.runtime.data += String.fromCharCode(bytes[i])
  ctx.runtime.dataDedup.set(key, ptr)
  return { ptr: ptrNode(ptr), len: bytes.length }
}

const sfTagIR = (val) =>
  typed(['if', ['result', 'i32'],
    ['i64.ne',
      ['i64.and', val, ['i64.const', SF_NAN_MASK]],
      ['i64.const', SF_NAN_MASK]],
    ['then', ['i32.const', SF_TAG_NUMBER]],
    ['else', ['i32.wrap_i64',
      ['i64.shr_u',
        ['i64.and', val, ['i64.const', SF_TAG_MASK]],
        ['i64.const', SF_TAG_SHIFT]]]]], 'i32')

const isTag = (arg, tag) =>
  typed(['i32.eq', sfTagIR(asI64(emit(arg))), ['i32.const', tag]], 'i32')

const inlineLenIR = (val) =>
  typed(['i32.wrap_i64',
    ['i64.shr_u',
      ['i64.and', val, ['i64.const', SF_VALUE_MASK]],
      ['i64.const', SF_VALUE_ENCODING_SIZE]]], 'i32')

const ptrIR = (arg) =>
  typed(['i32.wrap_i64',
    ['i64.and', asI64(emit(arg)), ['i64.const', SF_POINTER_MASK]]], 'i32')

const shapeString = (node) => {
  if (Array.isArray(node) && node[0] === 'str' && typeof node[1] === 'string') return node[1]
  if (Array.isArray(node) && node[0] == null && typeof node[1] === 'string') return node[1]
  return null
}

const normalizeShape = (shape) => {
  if (shape == null) return { kind: 'json', nullable: true }
  if (typeof shape === 'string') return { kind: shape }
  if (Array.isArray(shape)) return { kind: 'array', elem: normalizeShape(shape[0]) }
  if (typeof shape !== 'object') return { kind: 'json', nullable: true }
  if (shape.kind === 'nullable') {
    const inner = normalizeShape(shape.of || shape.inner || 'json')
    return { ...inner, nullable: true }
  }
  const kind = shape.kind || shape.type || (shape.fields || shape.props ? 'object' : shape.item || shape.elem ? 'array' : 'json')
  const out = { kind, nullable: !!shape.nullable }
  const fields = shape.fields || shape.props
  if (fields) {
    out.props = {}
    for (const [key, value] of Object.entries(fields)) out.props[key] = normalizeShape(value)
  }
  if (shape.item || shape.elem) out.elem = normalizeShape(shape.item || shape.elem)
  return out
}

const parseShape = (node) => {
  const src = shapeString(node)
  if (src == null) return { kind: 'json' }
  try { return normalizeShape(JSON.parse(src)) }
  catch { return { kind: 'json' } }
}

const childShape = (shape, prop) => {
  if (!shape) return null
  if ((shape.kind === 'object' || shape.kind === 'hash') && shape.props) return shape.props[prop] || null
  if (shape.kind === 'json') return { kind: 'json', nullable: true }
  return null
}

const indexShape = shape => {
  if (!shape) return null
  if (shape.kind === 'array') return shape.elem || { kind: 'json', nullable: true }
  if (shape.kind === 'json') return { kind: 'json', nullable: true }
  return null
}

const scalarKind = shape => shape?.kind === 'int' || shape?.kind === 'float' ? 'number' : shape?.kind

const valTypeForShape = (shape) => {
  switch (scalarKind(shape)) {
    case 'array': return 'array'
    case 'object': case 'hash': case 'json': return 'object'
    case 'string': return 'string'
    case 'number': case 'boolean': return 'number'
    default: return null
  }
}

const substExpr = (node, mapping) => {
  if (typeof node === 'string') return mapping.has(node) ? mapping.get(node) : node
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === '.' || op === '?.') return [op, substExpr(node[1], mapping), node[2]]
  if (op === ':') return [op, node[1], substExpr(node[2], mapping)]
  return [op, ...node.slice(1).map(arg => substExpr(arg, mapping))]
}

const exprUses = (node, name) => {
  if (typeof node === 'string') return node === name
  if (!Array.isArray(node)) return false
  const op = node[0]
  if (op === '.' || op === '?.') return exprUses(node[1], name)
  if (op === ':') return exprUses(node[2], name)
  return node.slice(1).some(arg => exprUses(arg, name))
}

const rewriteReturns = (node, result) => {
  if (!Array.isArray(node)) return node
  const op = node[0]
  if (op === 'return') return [';', ['=', result, node[1] ?? [, undefined]], ['break']]
  if (op === '=>' || op === 'function') return node
  return [op, ...node.slice(1).map(arg => rewriteReturns(arg, result))]
}

export default (ctx) => {
  inc('__alloc')

  Object.assign(ctx.core.stdlibDeps, {
    __sf_read_string: ['__alloc', '__mkptr'],
    __sf_str_to_buf: ['__alloc', '__str_byteLen', '__char_at'],
  })

  addImportOnce(ctx, 'shopify_function_input_get',
    ['func', '$__sf_input_get', ['result', 'i64']])
  addImportOnce(ctx, 'shopify_function_input_get_val_len',
    ['func', '$__sf_input_get_val_len', ['param', 'i64'], ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_input_read_utf8_str',
    ['func', '$__sf_input_read_utf8_str', ['param', 'i32'], ['param', 'i32'], ['param', 'i32']])
  addImportOnce(ctx, 'shopify_function_input_get_obj_prop',
    ['func', '$__sf_input_get_obj_prop', ['param', 'i64'], ['param', 'i32'], ['param', 'i32'], ['result', 'i64']])
  addImportOnce(ctx, 'shopify_function_input_get_interned_obj_prop',
    ['func', '$__sf_input_get_interned_obj_prop', ['param', 'i64'], ['param', 'i32'], ['result', 'i64']])
  addImportOnce(ctx, 'shopify_function_input_get_at_index',
    ['func', '$__sf_input_get_at_index', ['param', 'i64'], ['param', 'i32'], ['result', 'i64']])
  addImportOnce(ctx, 'shopify_function_input_get_obj_key_at_index',
    ['func', '$__sf_input_get_obj_key_at_index', ['param', 'i64'], ['param', 'i32'], ['result', 'i64']])
  addImportOnce(ctx, 'shopify_function_intern_utf8_str',
    ['func', '$__sf_intern_utf8_str', ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])

  ctx.core.stdlib['__sf_read_string'] = `(func $__sf_read_string (param $val i64) (result f64)
    (local $len i32) (local $src i32) (local $dst i32)
    (local.set $len
      (i32.wrap_i64
        (i64.shr_u
          (i64.and (local.get $val) (i64.const ${SF_VALUE_MASK}))
          (i64.const ${SF_VALUE_ENCODING_SIZE}))))
    (if (i32.ge_u (local.get $len) (i32.const ${SF_MAX_VALUE_LENGTH}))
      (then (local.set $len (call $__sf_input_get_val_len (local.get $val)))))
    (local.set $src
      (i32.wrap_i64
        (i64.and (local.get $val) (i64.const ${SF_POINTER_MASK}))))
    (local.set $dst (call $__alloc (i32.add (local.get $len) (i32.const 4))))
    (i32.store (local.get $dst) (local.get $len))
    (local.set $dst (i32.add (local.get $dst) (i32.const 4)))
    (call $__sf_input_read_utf8_str (local.get $src) (local.get $dst) (local.get $len))
    (call $__mkptr (i32.const ${PTR.STRING}) (i32.const 0) (local.get $dst)))`

  ctx.core.stdlib['__sf_str_to_buf'] = `(func $__sf_str_to_buf (param $str i64) (result i32)
    (local $len i32) (local $buf i32) (local $i i32)
    (local.set $len (call $__str_byteLen (local.get $str)))
    (local.set $buf (call $__alloc (local.get $len)))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8
        (i32.add (local.get $buf) (local.get $i))
        (call $__char_at (local.get $str) (local.get $i)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    (local.get $buf))`

  addImportOnce(ctx, 'shopify_function_output_new_bool',
    ['func', '$__sf_output_new_bool', ['param', 'i32'], ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_new_null',
    ['func', '$__sf_output_new_null', ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_new_i32',
    ['func', '$__sf_output_new_i32', ['param', 'i32'], ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_new_f64',
    ['func', '$__sf_output_new_f64', ['param', 'f64'], ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_new_utf8_str',
    ['func', '$__sf_output_new_utf8_str', ['param', 'i32'], ['param', 'i32'], ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_new_interned_utf8_str',
    ['func', '$__sf_output_new_interned_utf8_str', ['param', 'i32'], ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_new_object',
    ['func', '$__sf_output_new_object', ['param', 'i32'], ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_finish_object',
    ['func', '$__sf_output_finish_object', ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_new_array',
    ['func', '$__sf_output_new_array', ['param', 'i32'], ['result', 'i32']])
  addImportOnce(ctx, 'shopify_function_output_finish_array',
    ['func', '$__sf_output_finish_array', ['result', 'i32']])

  ctx.core.emit['shopify_function.inputGet'] = () =>
    typed(['f64.reinterpret_i64', ['call', '$__sf_input_get']], 'f64')

  ctx.core.emit['shopify_function.lazyInput'] = (shapeNode) => {
    const ir = typed(['f64.reinterpret_i64', ['call', '$__sf_input_get']], 'f64')
    ir.lazy = { hook, shape: parseShape(shapeNode) }
    return ir
  }

  ctx.core.emit['shopify_function.getObjProp'] = (scope, prop) => {
    const { ptr, len } = staticUtf8(ctx, literalString(prop, 'getObjProp'))
    return typed(['f64.reinterpret_i64',
      ['call', '$__sf_input_get_obj_prop',
        asI64(emit(scope)), ptr, ['i32.const', len]]], 'f64')
  }

  ctx.core.emit['shopify_function.getObjPropValueString'] = (scope, prop) => {
    inc('__sf_str_to_buf', '__str_byteLen')
    const t = tempI64('sfkey')
    const key = ['local.tee', `$${t}`, asI64(emit(prop))]
    return typed(['f64.reinterpret_i64',
      ['call', '$__sf_input_get_obj_prop',
        asI64(emit(scope)),
        ['call', '$__sf_str_to_buf', key],
        ['call', '$__str_byteLen', ['local.get', `$${t}`]]]], 'f64')
  }

  ctx.core.emit['shopify_function.getInternedObjProp'] = (scope, id) =>
    typed(['f64.reinterpret_i64',
      ['call', '$__sf_input_get_interned_obj_prop', asI64(emit(scope)), asI32(emit(id))]], 'f64')

  ctx.core.emit['shopify_function.getAtIndex'] = (scope, index) =>
    typed(['f64.reinterpret_i64',
      ['call', '$__sf_input_get_at_index', asI64(emit(scope)), asI32(emit(index))]], 'f64')

  ctx.core.emit['shopify_function.getObjKeyAtIndex'] = (scope, index) =>
    typed(['f64.reinterpret_i64',
      ['call', '$__sf_input_get_obj_key_at_index', asI64(emit(scope)), asI32(emit(index))]], 'f64')

  ctx.core.emit['shopify_function.internString'] = (value) => {
    const { ptr, len } = staticUtf8(ctx, literalString(value, 'internString'))
    return typed(['f64.convert_i32_u', ['call', '$__sf_intern_utf8_str', ptr, ['i32.const', len]]], 'f64')
  }

  ctx.core.emit['shopify_function.valLen'] = (scope) =>
    typed(['f64.convert_i32_u', ['call', '$__sf_input_get_val_len', asI64(emit(scope))]], 'f64')

  ctx.core.emit['shopify_function.inlineLen'] = (scope) =>
    typed(['f64.convert_i32_u', inlineLenIR(asI64(emit(scope)))], 'f64')

  ctx.core.emit['shopify_function.arrayLen'] = (scope) => {
    const v = asI64(emit(scope))
    const len = inlineLenIR(v)
    return typed(['f64.convert_i32_u',
      ['if', ['result', 'i32'],
        ['i32.lt_u', len, ['i32.const', SF_MAX_VALUE_LENGTH]],
        ['then', len],
        ['else', ['call', '$__sf_input_get_val_len', v]]]], 'f64')
  }

  ctx.core.emit['shopify_function.objectLen'] = ctx.core.emit['shopify_function.arrayLen']
  ctx.core.emit['shopify_function.stringLen'] = ctx.core.emit['shopify_function.arrayLen']

  ctx.core.emit['shopify_function.isNull'] = (value) => isTag(value, SF_TAG_NULL)
  ctx.core.emit['shopify_function.isBool'] = (value) => isTag(value, SF_TAG_BOOL)
  ctx.core.emit['shopify_function.isNumber'] = (value) => isTag(value, SF_TAG_NUMBER)
  ctx.core.emit['shopify_function.isString'] = (value) => isTag(value, SF_TAG_STRING)
  ctx.core.emit['shopify_function.isObject'] = (value) => isTag(value, SF_TAG_OBJECT)
  ctx.core.emit['shopify_function.isArray'] = (value) => isTag(value, SF_TAG_ARRAY)

  ctx.core.emit['shopify_function.asBool'] = (value) =>
    typed(['f64.convert_i32_u',
      ['i32.wrap_i64', ['i64.and', asI64(emit(value)), ['i64.const', SF_POINTER_MASK]]]], 'f64')

  ctx.core.emit['shopify_function.asNumber'] = (value) =>
    typed(['f64.reinterpret_i64', asI64(emit(value))], 'f64')

  ctx.core.emit['shopify_function.ptr'] = (value) =>
    typed(['f64.convert_i32_u', ptrIR(value)], 'f64')

  ctx.core.emit['shopify_function.readString'] = (value) => {
    inc('__sf_read_string')
    return typed(['call', '$__sf_read_string', asI64(emit(value))], 'f64')
  }

  const hook = {
    lazyOf(expr) {
      if (Array.isArray(expr) && expr[0] === '()' && expr[1] === 'shopify_function.lazyInput')
        return { hook, shape: parseShape(expr[2]) }
      return null
    },
    child(lazy, prop) {
      const shape = childShape(lazy.shape, prop)
      return shape ? { hook, shape } : null
    },
    index(lazy) {
      const shape = indexShape(lazy.shape)
      return shape ? { hook, shape } : null
    },
    valType(lazy) {
      return valTypeForShape(lazy.shape)
    },
    isNullish(_lazy, value) {
      return asI32(ctx.core.emit['shopify_function.isNull'](value))
    },
    emitValue(lazy, value) {
      const kind = scalarKind(lazy.shape)
      const coerce = (v) => {
        if (kind === 'string') return ctx.core.emit['shopify_function.readString'](v)
        if (kind === 'number') return ctx.core.emit['shopify_function.asNumber'](v)
        if (kind === 'boolean') return ctx.core.emit['shopify_function.asBool'](v)
        const out = asF64(emit(v))
        out.lazy = lazy
        return out
      }
      if (!lazy.shape?.nullable) return coerce(value)
      const t = `__sfv${ctx.func.uniq++}`
      ctx.func.locals.set(t, 'f64')
      const out = typed(['block', ['result', 'f64'],
        ['local.set', `$${t}`, asF64(emit(value))],
        ['if', ['result', 'f64'],
          asI32(ctx.core.emit['shopify_function.isNull'](t)),
          ['then', nullExpr()],
          ['else', asF64(coerce(t))]]], 'f64')
      if (kind !== 'string' && kind !== 'number' && kind !== 'boolean') out.lazy = lazy
      return out
    },
    emitProp(lazy, obj, prop) {
      const child = this.child(lazy, prop)
      if (!child) return null
      return this.emitValue(child, ctx.core.emit['shopify_function.getObjProp'](obj, ['str', prop]))
    },
    emitIndex(lazy, obj, idx) {
      const child = this.index(lazy)
      if (!child) return null
      return this.emitValue(child, ctx.core.emit['shopify_function.getAtIndex'](obj, idx))
    },
    emitLength(lazy, obj) {
      const kind = scalarKind(lazy.shape)
      if (kind === 'string') return ctx.core.emit['shopify_function.stringLen'](obj)
      if (kind === 'object' || kind === 'hash' || kind === 'json') return ctx.core.emit['shopify_function.objectLen'](obj)
      return ctx.core.emit['shopify_function.arrayLen'](obj)
    },
    emitMethod(lazy, obj, method, args, parsed) {
      if (scalarKind(lazy.shape) !== 'array' || parsed?.hasSpread) return null
      if (!['some', 'every', 'find', 'forEach', 'map', 'filter'].includes(method)) return null
      if (args.length !== 1) return null
      const itemLazy = this.index(lazy)
      if (!itemLazy) return null
      const cb = makeLazyArrayCallback(args[0], [
        { value: item => item, lazy: itemLazy },
        { value: (_item, idx) => typed(['f64.convert_i32_s', ['local.get', `$${idx}`]], 'f64') },
        { value: (_item, _idx, arr) => arr, lazy },
      ])
      if (!cb) return null

      const src = temp('sfarr')
      const len = tempI32('sflen')
      const idx = tempI32('sfi')
      const item = temp('sfitem')
      const loopId = ctx.func.uniq++
      const out = []
      out.push(['local.set', `$${src}`, asF64(emit(obj))])
      out.push(['local.set', `$${len}`, asI32(ctx.core.emit['shopify_function.arrayLen'](src))])
      out.push(['local.set', `$${idx}`, ['i32.const', 0]])
      updateRep(item, { lazy: itemLazy })
      const itemValue = typed(['local.get', `$${item}`], 'f64')
      itemValue.lazy = itemLazy
      const srcValue = typed(['local.get', `$${src}`], 'f64')
      srcValue.lazy = lazy

      const next = [
        ['local.set', `$${item}`, asF64(this.emitIndex(lazy, src, idx))],
      ]

      if (method === 'some' || method === 'every' || method === 'find') {
        const result = temp('sfr')
        const done = `$sfdone${loopId}`
        const initial = method === 'every' ? ['f64.const', 1] : method === 'find' ? nullExpr() : ['f64.const', 0]
        out.push(['local.set', `$${result}`, initial])
        const pass = truthyIR(cb.call(itemValue, idx, srcValue))
        const hit = method === 'some'
          ? [['local.set', `$${result}`, ['f64.const', 1]], ['br', done]]
          : method === 'every'
            ? [['local.set', `$${result}`, ['f64.const', 0]], ['br', done]]
            : [['local.set', `$${result}`, itemValue], ['br', done]]
        const test = method === 'every' ? ['i32.eqz', pass] : pass
        next.push(['if', test, ['then', ...hit]])
        out.push(['block', done,
          ['loop', `$sfloop${loopId}`,
            ['br_if', done, ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
            ...next,
            ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', 1]]],
            ['br', `$sfloop${loopId}`]]])
        out.push(['local.get', `$${result}`])
        return typed(['block', ['result', 'f64'], ...out], 'f64')
      }

      if (method === 'forEach') {
        next.push(['drop', asF64(cb.call(itemValue, idx, srcValue))])
        out.push(['block', `$sfdone${loopId}`,
          ['loop', `$sfloop${loopId}`,
            ['br_if', `$sfdone${loopId}`, ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
            ...next,
            ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', 1]]],
            ['br', `$sfloop${loopId}`]]],
          ['f64.const', 0])
        return typed(['block', ['result', 'f64'], ...out], 'f64')
      }

      if (method === 'map') {
        const mapped = temp('sfmapv')
        const result = allocPtr({ type: PTR.ARRAY, len: ['local.get', `$${len}`], tag: 'sfmap' })
        out.push(result.init)
        next.push(
          ['local.set', `$${mapped}`, asF64(cb.call(itemValue, idx, srcValue))],
          elemStore(result.local, idx, ['local.get', `$${mapped}`]),
        )
        out.push(['block', `$sfdone${loopId}`,
          ['loop', `$sfloop${loopId}`,
            ['br_if', `$sfdone${loopId}`, ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
            ...next,
            ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', 1]]],
            ['br', `$sfloop${loopId}`]]],
          result.ptr)
        return typed(['block', ['result', 'f64'], ...out], 'f64')
      }

      if (method === 'filter') {
        const count = tempI32('sffcnt')
        const result = allocPtr({ type: PTR.ARRAY, len: 0, cap: ['local.get', `$${len}`], tag: 'sffilter' })
        out.push(result.init, ['local.set', `$${count}`, ['i32.const', 0]])
        next.push(['if', truthyIR(cb.call(itemValue, idx, srcValue)),
          ['then',
            elemStore(result.local, count, itemValue),
            ['local.set', `$${count}`, ['i32.add', ['local.get', `$${count}`], ['i32.const', 1]]]]])
        out.push(['block', `$sfdone${loopId}`,
          ['loop', `$sfloop${loopId}`,
            ['br_if', `$sfdone${loopId}`, ['i32.ge_u', ['local.get', `$${idx}`], ['local.get', `$${len}`]]],
            ...next,
            ['local.set', `$${idx}`, ['i32.add', ['local.get', `$${idx}`], ['i32.const', 1]]],
            ['br', `$sfloop${loopId}`]]],
          ['i32.store', ['i32.sub', ['local.get', `$${result.local}`], ['i32.const', 8]], ['local.get', `$${count}`]],
          result.ptr)
        return typed(['block', ['result', 'f64'], ...out], 'f64')
      }

      return null
    },
  }

  function makeLazyArrayCallback(fn, params) {
    if (!Array.isArray(fn) || fn[0] !== '=>') return null
    const raw = extractParams(fn[1])
    if (!raw.every(p => typeof p === 'string')) return null
    const body = fn[2]
    return {
      call(item, idx, arr) {
        const mapping = new Map()
        const stmts = []
        const values = [item, idx, arr]
        for (let i = 0; i < raw.length; i++) {
          if (!exprUses(body, raw[i])) continue
          const param = params[i]
          if (!param) continue
          const local = temp('sfcb')
          mapping.set(raw[i], local)
          const value = param.value(...values)
          stmts.push(['local.set', `$${local}`, asF64(value)])
          if (param.lazy) {
            updateRep(local, { lazy: param.lazy })
            const vt = param.lazy.hook?.valType?.(param.lazy)
            if (vt) updateRep(local, { val: vt })
          }
        }
        if (Array.isArray(body) && body[0] === '{}') {
          const result = temp('sfret')
          const done = `$sfret${ctx.func.uniq++}`
          const rewritten = substExpr(rewriteReturns(body, result), mapping)
          ctx.func.stack.push({ brk: done, loop: done })
          let bodyIR
          try {
            bodyIR = emitFlat(rewritten)
          } finally {
            ctx.func.stack.pop()
          }
          return typed(['block', ['result', 'f64'],
            ...stmts,
            ['local.set', `$${result}`, undefExpr()],
            ['block', done, ...bodyIR],
            ['local.get', `$${result}`]], 'f64')
        }
        return typed(['block', ['result', 'f64'], ...stmts, asF64(emit(substExpr(body, mapping)))], 'f64')
      },
    }
  }
  ctx.core.lazyAccess.push(hook)

  ctx.core.emit['shopify_function.outputBool'] = (value) =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_new_bool', asI32(emit(value))]], 'f64')
  ctx.core.emit['shopify_function.outputNull'] = () =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_new_null']], 'f64')
  ctx.core.emit['shopify_function.outputI32'] = (value) =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_new_i32', asI32(emit(value))]], 'f64')
  ctx.core.emit['shopify_function.outputF64'] = (value) =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_new_f64', asF64(emit(value))]], 'f64')
  ctx.core.emit['shopify_function.outputString'] = (value) => {
    const { ptr, len } = staticUtf8(ctx, literalString(value, 'outputString'))
    return typed(['f64.convert_i32_s', ['call', '$__sf_output_new_utf8_str', ptr, ['i32.const', len]]], 'f64')
  }
  ctx.core.emit['shopify_function.outputValueString'] = (value) => {
    inc('__sf_str_to_buf', '__str_byteLen')
    const t = tempI64('sfstr')
    const str = ['local.tee', `$${t}`, asI64(emit(value))]
    return typed(['f64.convert_i32_s',
      ['call', '$__sf_output_new_utf8_str',
        ['call', '$__sf_str_to_buf', str],
        ['call', '$__str_byteLen', ['local.get', `$${t}`]]]], 'f64')
  }
  ctx.core.emit['shopify_function.outputInternedString'] = (id) =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_new_interned_utf8_str', asI32(emit(id))]], 'f64')
  ctx.core.emit['shopify_function.outputObject'] = (len) =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_new_object', asI32(emit(len))]], 'f64')
  ctx.core.emit['shopify_function.outputFinishObject'] = () =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_finish_object']], 'f64')
  ctx.core.emit['shopify_function.outputArray'] = (len) =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_new_array', asI32(emit(len))]], 'f64')
  ctx.core.emit['shopify_function.outputFinishArray'] = () =>
    typed(['f64.convert_i32_s', ['call', '$__sf_output_finish_array']], 'f64')
}
