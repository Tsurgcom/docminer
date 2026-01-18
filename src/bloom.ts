export interface BloomFilterInit {
  buffer: SharedArrayBuffer;
  bitCount: number;
  hashCount: number;
  hashSeeds: [number, number];
}

export interface KnownUrlLookup {
  has(value: string): boolean;
  readonly isProbabilistic?: boolean;
}

const DEFAULT_BITS_PER_ITEM = 10;
const DEFAULT_HASH_SEEDS: [number, number] = [0x81_1c_9d_c5, 0x9e_37_79_b1];
const UINT32_BASE = 2 ** 32;

const hashString = (value: string, seed: number): number => {
  let hash = seed % UINT32_BASE;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    hash = (Math.imul(hash, 31) + code) % UINT32_BASE;
    if (hash < 0) {
      hash += UINT32_BASE;
    }
  }
  return hash;
};

const computeBitCount = (capacity: number, bitsPerItem: number): number => {
  const safeCapacity = Math.max(1, Math.ceil(capacity));
  return Math.max(1, Math.ceil(safeCapacity * bitsPerItem));
};

const buildInit = (capacity: number, bitsPerItem: number): BloomFilterInit => {
  const bitCount = computeBitCount(capacity, bitsPerItem);
  const buffer = new SharedArrayBuffer(bitCount * Int32Array.BYTES_PER_ELEMENT);
  const hashCount = Math.max(1, Math.round(bitsPerItem * Math.log(2)));
  return {
    buffer,
    bitCount,
    hashCount,
    hashSeeds: DEFAULT_HASH_SEEDS,
  };
};

export class BloomFilter implements KnownUrlLookup {
  private readonly bits: Int32Array;
  private readonly bitCount: number;
  private readonly hashCount: number;
  private readonly hashSeeds: [number, number];
  readonly isProbabilistic = true;

  constructor(init: BloomFilterInit) {
    this.bits = new Int32Array(init.buffer);
    this.bitCount = init.bitCount;
    this.hashCount = init.hashCount;
    this.hashSeeds = init.hashSeeds;
  }

  static create(
    capacity: number,
    bitsPerItem = DEFAULT_BITS_PER_ITEM
  ): { filter: BloomFilter; init: BloomFilterInit } {
    const init = buildInit(capacity, bitsPerItem);
    return { filter: new BloomFilter(init), init };
  }

  add(value: string): void {
    const [seed1, seed2] = this.hashSeeds;
    const hash1 = hashString(value, seed1);
    const hash2 = hashString(value, seed2) || 0x9e_37_79_b1;
    for (let i = 0; i < this.hashCount; i += 1) {
      const combined = (hash1 + i * hash2) % this.bitCount;
      const bitIndex = combined < 0 ? combined + this.bitCount : combined;
      Atomics.store(this.bits, bitIndex, 1);
    }
  }

  has(value: string): boolean {
    const [seed1, seed2] = this.hashSeeds;
    const hash1 = hashString(value, seed1);
    const hash2 = hashString(value, seed2) || 0x9e_37_79_b1;
    for (let i = 0; i < this.hashCount; i += 1) {
      const combined = (hash1 + i * hash2) % this.bitCount;
      const bitIndex = combined < 0 ? combined + this.bitCount : combined;
      if (Atomics.load(this.bits, bitIndex) !== 1) {
        return false;
      }
    }
    return true;
  }
}
