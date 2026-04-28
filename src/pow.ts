// Import WASM module directly in ES module worker
import wasmModule from "../assets/sha3_wasm_bg.wasm";

let wasmInstance: WebAssembly.Instance | null = null;

function getWasmInstance(): WebAssembly.Instance {
  if (!wasmInstance) {
    // wasmModule imported above is already a WebAssembly.Module in Workers ES modules
    wasmInstance = new WebAssembly.Instance(wasmModule as unknown as WebAssembly.Module, {
      env: {},
    });
  }
  return wasmInstance;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  __wbindgen_add_to_stack_pointer: (n: number) => number;
  __wbindgen_export_0: (size: number, align: number) => number;
  wasm_solve: (
    retptr: number,
    ptrChallenge: number,
    lenChallenge: number,
    ptrPrefix: number,
    lenPrefix: number,
    difficulty: number
  ) => void;
}

function getExports(): WasmExports {
  const instance = getWasmInstance();
  const exp = instance.exports as unknown as WasmExports;
  return exp;
}

function writeMemory(memory: WebAssembly.Memory, offset: number, data: Uint8Array): void {
  const view = new Uint8Array(memory.buffer);
  view.set(data, offset);
}

function readMemory(memory: WebAssembly.Memory, offset: number, size: number): Uint8Array {
  return new Uint8Array(memory.buffer, offset, size);
}

function encodeString(memory: WebAssembly.Memory, alloc: (size: number, align: number) => number, text: string): { ptr: number; len: number } {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const len = data.length;
  const ptr = alloc(len, 1);
  writeMemory(memory, ptr, data);
  return { ptr, len };
}

export function computePowAnswer(
  algorithm: string,
  challengeStr: string,
  salt: string,
  difficulty: number,
  expireAt: number,
  _signature: string,
  _targetPath: string
): number | null {
  if (algorithm !== "DeepSeekHashV1") {
    throw new Error(`Unsupported algorithm: ${algorithm}`);
  }
  const prefix = `${salt}_${expireAt}_`;

  const { memory, __wbindgen_add_to_stack_pointer, __wbindgen_export_0, wasm_solve } = getExports();

  // 1. Allocate 16 bytes on stack
  const retptr = __wbindgen_add_to_stack_pointer(-16);

  // 2. Encode challenge and prefix into wasm memory
  const { ptr: ptrChallenge, len: lenChallenge } = encodeString(memory, __wbindgen_export_0, challengeStr);
  const { ptr: ptrPrefix, len: lenPrefix } = encodeString(memory, __wbindgen_export_0, prefix);

  // 3. Call wasm_solve (difficulty passed as float)
  wasm_solve(retptr, ptrChallenge, lenChallenge, ptrPrefix, lenPrefix, difficulty);

  // 4. Read 4-byte status and 8-byte result from retptr
  const statusBytes = readMemory(memory, retptr, 4);
  const statusView = new DataView(statusBytes.buffer, statusBytes.byteOffset, 4);
  const status = statusView.getInt32(0, true); // little-endian

  if (status === 0) {
    __wbindgen_add_to_stack_pointer(16);
    return null;
  }

  const valueBytes = readMemory(memory, retptr + 8, 8);
  const valueView = new DataView(valueBytes.buffer, valueBytes.byteOffset, 8);
  const value = valueView.getFloat64(0, true); // little-endian

  // 5. Restore stack pointer
  __wbindgen_add_to_stack_pointer(16);

  return Math.floor(value);
}
