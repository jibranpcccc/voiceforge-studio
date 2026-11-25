/**
 * Pure TypeScript NumPy (.npy) v1/v2/v3 parser.
 */

export type NpyTypedArray =
  | Float32Array
  | Float64Array
  | Int32Array
  | BigInt64Array
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array;

export interface ParsedNpyArray {
  dtype: string;
  fortranOrder: boolean;
  shape: number[];
  data: NpyTypedArray;
}

const NPY_MAGIC = [0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59] as const;

interface ParsedHeader {
  descr: string;
  fortranOrder: boolean;
  shape: number[];
}

function parseNpyHeaderDict(headerText: string): ParsedHeader {
  const descrMatch = headerText.match(/'descr'\s*:\s*'([^']+)'/);
  const fortranMatch = headerText.match(/'fortran_order'\s*:\s*(True|False)/);
  const shapeMatch = headerText.match(/'shape'\s*:\s*\(([^)]*)\)/);

  if (!descrMatch || !fortranMatch || !shapeMatch) {
    throw new Error(`Invalid NPY header metadata: ${headerText}`);
  }

  const shapeBody = shapeMatch[1].trim();
  const shape =
    shapeBody.length === 0
      ? []
      : shapeBody
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map((part) => {
            const parsed = Number.parseInt(part, 10);
            if (!Number.isFinite(parsed) || parsed < 0) {
              throw new Error(`Invalid NPY dimension "${part}"`);
            }
            return parsed;
          });

  return {
    descr: descrMatch[1],
    fortranOrder: fortranMatch[1] === 'True',
    shape,
  };
}

function toUint8View(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function reorderBigEndian(bytes: Uint8Array, elementSize: number): Uint8Array {
  const copy = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += elementSize) {
    for (let j = 0; j < elementSize; j++) {
      copy[i + j] = bytes[i + elementSize - 1 - j];
    }
  }
  return copy;
}

/**
 * Parse a NumPy `.npy` file (v1.0, v2.0, or v3.0) into dtype, shape, and typed data.
 */
export function parseNpy(input: ArrayBuffer | ArrayBufferView): ParsedNpyArray {
  const bytes = toUint8View(input);
  if (bytes.length < 10) {
    throw new Error(`NPY buffer too short (${bytes.length} bytes).`);
  }

  for (let i = 0; i < NPY_MAGIC.length; i++) {
    if (bytes[i] !== NPY_MAGIC[i]) {
      throw new Error('Invalid NPY magic header.');
    }
  }

  const major = bytes[6];
  const minor = bytes[7];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let headerLen: number;
  let headerStart: number;
  if (major === 1 && minor === 0) {
    headerLen = view.getUint16(8, true);
    headerStart = 10;
  } else if ((major === 2 || major === 3) && minor === 0) {
    if (bytes.length < 12) {
      throw new Error(`NPY v${major} buffer too short.`);
    }
    headerLen = view.getUint32(8, true);
    headerStart = 12;
  } else {
    throw new Error(`Unsupported NPY format version ${major}.${minor}.`);
  }

  const dataStart = headerStart + headerLen;
  if (dataStart > bytes.length) {
    throw new Error('NPY header length exceeds buffer size.');
  }

  const decoder = new TextDecoder(major === 3 ? 'utf-8' : 'latin1');
  const headerText = decoder.decode(bytes.subarray(headerStart, dataStart)).trim();
  const { descr, fortranOrder, shape } = parseNpyHeaderDict(headerText);

  if (fortranOrder && shape.length > 1) {
    throw new Error('Fortran-ordered multi-dimensional NPY arrays are not supported.');
  }

  const elementCount = shape.reduce((acc, dim) => acc * dim, 1);
  const rawPayload = bytes.subarray(dataStart);
  const endian = descr[0];
  const typeTag = descr.slice(1);

  const ensureAlignedCopy = (byteSize: number): ArrayBuffer => {
    const expectedBytes = elementCount * byteSize;
    if (rawPayload.byteLength < expectedBytes) {
      throw new Error(
        `NPY payload truncated: expected ${expectedBytes} bytes, found ${rawPayload.byteLength}.`
      );
    }
    const slice = rawPayload.subarray(0, expectedBytes);
    const normalized = endian === '>' && byteSize > 1 ? reorderBigEndian(slice, byteSize) : slice;
    const aligned = new Uint8Array(expectedBytes);
    aligned.set(normalized);
    return aligned.buffer;
  };

  let data: NpyTypedArray;
  switch (typeTag) {
    case 'f4':
      data = new Float32Array(ensureAlignedCopy(4));
      break;
    case 'f8':
      data = new Float64Array(ensureAlignedCopy(8));
      break;
    case 'i4':
      data = new Int32Array(ensureAlignedCopy(4));
      break;
    case 'i8':
      data = new BigInt64Array(ensureAlignedCopy(8));
      break;
    case 'i2':
      data = new Int16Array(ensureAlignedCopy(2));
      break;
    case 'u2':
      data = new Uint16Array(ensureAlignedCopy(2));
      break;
    case 'i1':
      data = new Int8Array(ensureAlignedCopy(1));
      break;
    case 'u1':
    case 'b1':
      data = new Uint8Array(ensureAlignedCopy(1));
      break;
    default:
      throw new Error(`Unsupported NPY dtype "${descr}".`);
  }

  return {
    dtype: descr,
    fortranOrder,
    shape,
    data,
  };
}

/**
 * Parse a `.npy` buffer and return a Float32Array (converting from Float64 if needed).
 */
export function parseNpyFloat32(input: ArrayBuffer | ArrayBufferView): {
  shape: number[];
  data: Float32Array;
} {
  const parsed = parseNpy(input);
  if (parsed.data instanceof Float32Array) {
    return { shape: parsed.shape, data: parsed.data };
  }
  if (parsed.data instanceof Float64Array) {
    const out = new Float32Array(parsed.data.length);
    for (let i = 0; i < parsed.data.length; i++) {
      out[i] = parsed.data[i];
    }
    return { shape: parsed.shape, data: out };
  }
  throw new Error(`Expected floating-point NPY array, got dtype "${parsed.dtype}".`);
}
