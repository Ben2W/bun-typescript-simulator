# Zig to TypeScript Porting Guide

This guide defines the intentionally mechanical port from Bun's Zig source into
TypeScript. The target is not idiomatic TypeScript. The target is a
TypeScript-hosted Zig execution model that can run translated Bun-shaped code on
top of simulated memory, simulated allocators, and explicit layout metadata.

The core rule: preserve Zig semantics first, TypeScript ergonomics second.

## Goal

Port Bun to TypeScript by translating Zig into low-level TypeScript that uses a
runtime simulator:

- pointers are integer offsets into an `ArrayBuffer`;
- Zig slices are `{ ptr, len }` pairs;
- allocators operate on simulated memory;
- structs, unions, packed structs, and enums use explicit layout descriptors;
- `defer` lowers to cleanup stacks or `try`/`finally`;
- Zig error unions lower to a small `Result<T, E>` runtime type;
- native and JavaScriptCore boundaries are adapters, stubs, or Node-backed
  facades until a later phase replaces them.

This is a simulator port, not a source-level TypeScript rewrite. Generated code
must look like a lowered systems program, not a JavaScript application.

## Repository layout

Place simulator infrastructure under `src/ts-sim/` and generated code under
`src/ts-port/`:

```txt
src/ts-sim/
  allocator.ts
  bitfield.ts
  defer.ts
  error.ts
  layout.ts
  memory.ts
  ptr.ts
  slice.ts
  std/
    array_list.ts
    hash_map.ts
    os.ts
    fs.ts
  bun/
    jsc.ts
    sys.ts
src/ts-port/
  ...generated TypeScript mirroring src/**/*.zig...
```

Generated files should retain the source path in their header:

```ts
// Ported from src/foo/bar.zig.
// Generated for the TypeScript simulator; do not idiomatize by hand.
```

## Phase plan

### Phase A: Mechanical translation

Generate `.ts` files that typecheck against simulator APIs. The output does not
need to pass Bun tests yet. Prefer faithful structure over clever rewrites.

Do:

- preserve source file boundaries;
- preserve function names where TypeScript permits them;
- preserve control flow;
- lower allocations, pointer math, and slices to simulator calls;
- add `TODO(port-ts):` only at native, comptime, or unsupported boundaries.

Do not:

- rewrite structs into normal classes;
- replace pointer graphs with object graphs;
- replace allocators with garbage collection;
- silently change packed layout or integer widths;
- use `any` except at explicit native and JSC boundaries.

### Phase B: Runtime completeness

Implement enough `src/ts-sim/` to execute translated subsystems:

- memory read/write primitives;
- struct layout reads/writes;
- slices and sentinel slices;
- allocator interfaces;
- `ArrayList`, hash maps, and string helpers used by Bun;
- error unions and optionals;
- `defer` cleanup ordering.

### Phase C: Bun adapters

Bridge unavoidable host behavior:

- JavaScript execution via Node/V8 facade first;
- filesystem, networking, timers, and process APIs through Node;
- native C/C++/JavaScriptCore dependencies behind typed adapter modules;
- unsupported native behavior as explicit throwing stubs.

### Phase D: Test-driven parity

Run translated modules against selected Bun tests. Fix simulator behavior before
rewriting generated code. Hand edits to generated code are allowed only when the
translator cannot express required semantics yet; record those cases as
translator bugs.

## Type mapping

| Zig               | TypeScript simulator                                    |
| ----------------- | ------------------------------------------------------- |
| `*T`              | `Ptr<T>`                                                |
| `[*]T`            | `ManyPtr<T>` or `Ptr<T>` with explicit length nearby    |
| `[]T`             | `Slice<T>`                                              |
| `[:sentinel]T`    | `SentinelSlice<T, Sentinel>`                            |
| `?T`              | `Optional<T>` or `null` only for pointer-like optionals |
| `!T`              | `Result<T, ZigError>`                                   |
| `error{A,B}`      | string-literal union or generated numeric error set     |
| `void`            | `void`                                                  |
| `bool`            | `boolean`                                               |
| `usize` / `isize` | `number` with `Usize` / `Isize` brands                  |
| `u8` / `i8`       | `number` with simulator read/write width                |
| `u16` / `i16`     | `number` with simulator read/write width                |
| `u32` / `i32`     | `number` with simulator read/write width                |
| `u64` / `i64`     | `bigint` unless proven safe as `number`                 |
| `comptime_int`    | generated literal or `bigint`                           |
| `enum`            | generated numeric constants plus type brand             |
| `union(enum)`     | tagged layout helper                                    |
| `packed struct`   | bitfield helper over `number` or `bigint`               |
| `extern struct`   | `StructLayout` with C ABI-compatible offsets            |
| `anyopaque`       | `OpaquePtr`                                             |

## Memory model

All Zig-owned memory lives in a simulator heap:

```ts
export type Ptr<T = unknown> = number & { readonly __ptr?: T };

export class ZigMemory {
  readonly buffer: ArrayBuffer;
  readonly view: DataView;

  malloc(size: number, align?: number): Ptr;
  free(ptr: Ptr): void;
  readU32(ptr: Ptr): number;
  writeU32(ptr: Ptr, value: number): void;
}
```

Generated code must read and write through `ZigMemory` or layout helpers:

```ts
const pkg = allocator.create(layouts.PackageJSON);
memory.writeU32(pkg + layouts.PackageJSON.fields.version.offset, version);
```

Do not translate this to:

```ts
const pkg = new PackageJSON();
pkg.version = version;
```

That loses layout, aliasing, pointer identity, and allocator behavior.

## Pointers

| Zig operation                    | TypeScript simulator                    |
| -------------------------------- | --------------------------------------- |
| `@ptrCast(*T, p)`                | `ptrCast<T>(p)`                         |
| `@alignCast(p)`                  | `alignCast(p, alignOf(T))`              |
| `@constCast(p)`                  | `constCast(p)`                          |
| `ptr + n`                        | `ptrAdd(ptr, n, sizeOf(T))`             |
| `ptr.*` read                     | `load(layout, ptr)`                     |
| `ptr.* = value`                  | `store(layout, ptr, value)`             |
| `@fieldParentPtr(T, "field", p)` | `fieldParentPtr(layouts.T, "field", p)` |
| `@intFromPtr(p)`                 | `ptrToInt(p)`                           |
| `@ptrFromInt(n)`                 | `intToPtr<T>(n)`                        |

Raw pointer casts are allowed in generated code, but every cast should stay
visible. Do not hide them behind object construction.

## Allocators

Translate allocator calls to simulator allocators:

| Zig                     | TypeScript simulator                   |
| ----------------------- | -------------------------------------- |
| `allocator.alloc(T, n)` | `allocator.allocArray(layoutOf(T), n)` |
| `allocator.create(T)`   | `allocator.create(layoutOf(T))`        |
| `allocator.destroy(p)`  | `allocator.destroy(layoutOf(T), p)`    |
| `allocator.free(slice)` | `allocator.freeSlice(slice)`           |
| `allocator.dupe(T, s)`  | `allocator.dupe(layoutOf(T), s)`       |
| `bun.default_allocator` | `runtime.defaultAllocator`             |
| `bun.handleOom(expr)`   | `handleOom(() => expr)`                |

V8 garbage collection manages only the simulator objects. It does not own
translated Bun allocations. A translated `free` must call the simulator
allocator even when the first implementation is a no-op.

## Structs and layout

Every translated Zig struct gets a `StructLayout`:

```ts
export const PackageJSON = structLayout("PackageJSON", {
  size: 48,
  align: 8,
  fields: {
    name: { offset: 0, layout: SliceU8 },
    version: { offset: 16, layout: SliceU8 },
  },
});
```

Generated access should use layout helpers:

```ts
const name = layoutGet(layouts.PackageJSON, ptr, "name");
layoutSet(layouts.PackageJSON, ptr, "version", version);
```

Never assume TypeScript property order or object identity has anything to do
with Zig layout.

## Integers

JavaScript numbers are IEEE-754 doubles. Zig integer semantics are not.

Rules:

- use `number` for integers up to 32 bits;
- use `bigint` for 64-bit integer values unless a specific hot path documents a
  safe `number` representation;
- all arithmetic that depends on wrapping must call width-specific helpers;
- all shifts must use helpers when the width is not exactly JavaScript's signed
  32-bit behavior.

Examples:

```ts
u32Add(a, b);
u64And(a, b);
i16Trunc(value);
```

## Slices and strings

Represent Zig slices as `{ ptr, len }`:

```ts
export interface Slice<T> {
  ptr: Ptr<T>;
  len: Usize;
}
```

Rules:

- `[]const u8` is still a simulator slice;
- JS strings are allowed only at host boundaries;
- convert with explicit helpers such as `sliceToString(memory, slice)`;
- sentinel slices must preserve the sentinel in memory.

## Error unions

Lower `!T` to `Result<T, ZigError>`:

```ts
type Result<T, E extends ZigError = ZigError> =
  | { ok: true; value: T }
  | { ok: false; error: E };
```

`try expr` becomes:

```ts
const result = expr();
if (!result.ok) return result;
const value = result.value;
```

At JavaScript-facing adapter boundaries, errors may throw only after conversion
from the Zig error representation.

## `defer` and cleanup

Translate `defer` to cleanup stacks when a function has multiple dynamic
cleanup sites:

```ts
const defer = new DeferStack();
try {
  defer.push(() => allocator.freeSlice(bytes));
  return ok(value);
} finally {
  defer.run();
}
```

For a single static cleanup, direct `try`/`finally` is acceptable. Preserve
reverse-order execution.

## `comptime`

Do not emulate all of Zig comptime at runtime.

Preferred order:

1. generate a specialization during translation;
2. use a generated layout or constant table;
3. use a runtime function only when the source semantics are naturally runtime;
4. add `TODO(port-ts): comptime` when the translator cannot lower the construct.

## Standard library subset

Implement the Zig standard library only as needed by Bun. Start with:

- `std.mem`;
- `std.ArrayList` and `std.ArrayListUnmanaged`;
- hash maps used by Bun;
- `std.fs` adapters over `node:fs`;
- `std.os` and platform constants;
- formatting helpers used by logs and diagnostics.

Keep method names close to Zig where practical. The simulator is allowed to be
ugly if that keeps generated code mechanical.

## JavaScriptCore and host boundaries

The TypeScript simulator does not embed JavaScriptCore. The first implementation
uses a Node/V8-backed facade:

```txt
src/ts-sim/bun/jsc.ts
```

Rules:

- keep every JSC API call behind this facade;
- preserve handles as simulated pointers or opaque IDs;
- document semantic mismatches with `TODO(port-ts): jsc`;
- prefer throwing stubs over silent success for unsupported native behavior.

## Translation checklist

For each Zig file:

1. create a matching generated TypeScript file under `src/ts-port/`;
2. emit imports from `src/ts-sim/`;
3. emit type/layout descriptors before functions;
4. lower globals and constants;
5. lower functions mechanically;
6. keep unsupported constructs as explicit `TODO(port-ts):` stubs;
7. run TypeScript typecheck for the generated file;
8. add or update simulator coverage when a new runtime primitive is needed.

## Style rules

- Generated code may be verbose.
- Prefer branded primitive types over `any`.
- Keep pointer math explicit.
- Keep host conversions explicit.
- Do not use classes for translated Zig structs unless the source type has
  behavior that is not layout-sensitive.
- Do not "clean up" translated control flow.
- Do not silently replace native behavior with JavaScript behavior.

## Initial success criteria

The first useful milestone is not a working Bun binary. It is:

- a simulator heap with allocation, free, and typed reads/writes;
- generated TypeScript for a small, dependency-light Zig module;
- one translated module test passing against the simulator;
- clear unsupported stubs for native and JSC behavior.

After that, expand by subsystem: collections, strings, filesystem helpers,
package manager logic, transpiler support, then CLI/runtime adapters.
