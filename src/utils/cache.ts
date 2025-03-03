import * as fs from "fs";
import { Token, handlerContext } from "generated";
import * as path from "path";
import { ReturnPromiseType } from "./types";
import { Balances } from "./common";
import * as lockfile from 'proper-lockfile';

export const CacheCategory = {
  Token: "token",
  Instrument: "instrument",
  TokenPair: "token-pair",
  Balances: "balances",
  MarkPrice: "mark-price",
} as const;

export type CacheCategory = (typeof CacheCategory)[keyof typeof CacheCategory];

type Address = string;
type InstrumentId = string;

type ShapeToken = Record<Address, Token>;
type ShapeInstrument = Record<Address, ReturnPromiseType<handlerContext["Instrument"]["get"]>>;
type ShapeTokenPair = Record<InstrumentId, { collateralToken: Token; debtToken: Token }>;
type ShapeMarkPrice = Record<InstrumentId, bigint>;

// key: `${positionId}-${blockNumber}`
type ShapeBalances = Record<string, Balances>;

type Shape = ShapeToken | ShapeInstrument | ShapeTokenPair | ShapeBalances | ShapeMarkPrice;

export class Cache {
  static async init<C extends CacheCategory>(
{ category, chainId }: { category: C; chainId: number | string | bigint; }  ) {
    if (!Object.values(CacheCategory).find((c) => c === category)) {
      throw new Error("Unsupported cache category");
    }

    type S = C extends "token" ? ShapeToken : C extends "instrument" ? ShapeInstrument : C extends "token-pair" ? ShapeTokenPair : C extends "balances" ? ShapeBalances : C extends "mark-price" ? ShapeMarkPrice : never
    const entry = new Entry<S>(`${category}-${chainId.toString()}`);
    await entry.load()
    return entry;
  }
}

const replacer = (_key: string, value: any) => {
  if (typeof value === 'bigint') {
    return value.toString() + 'n'
  }
  return value
}

const reviver = (_key: string, value: any) => {
  if (typeof value === 'string' && /^-?\d+n$/.test(value)) {
    return BigInt(value.slice(0, -1))
  }
  return value
}

export class Entry<T extends Shape> {
  private memory: T = {} as T;
  private lockRelease: (() => Promise<void>) | null = null;

  static encoding = "utf8" as const;
  static folder = "./.cache" as const;

  public readonly key: string;
  public readonly file: string;

  constructor(key: string) {
    this.key = key;
    this.file = Entry.resolve(key);
  }

  private async acquireLock(): Promise<void> {
    try {
      this.lockRelease = await lockfile.lock(this.file, { retries: 10 })
    } catch (error) {
      console.error('Failed to acquire lock:', error);
      throw error;
    }
  }

  private async releaseLock(): Promise<void> {
    if (this.lockRelease) {
      await this.lockRelease();
      this.lockRelease = null;
    }
  }

  public async load() {
    try {
      this.preflight()
      await this.acquireLock();
      const data = fs.readFileSync(this.file, Entry.encoding);
      this.memory = JSON.parse(data, reviver) as T;
    } catch (error) {
      console.error(error);
      this.memory = {} as T;
    } finally {
      await this.releaseLock();
    }
  }

  public read<K extends keyof T>(key: K): T[K] {
    const memory = this.memory || {};
    return memory[key] as T[K];
  }

  public async add<N extends T>(fields: N) {
    try {
      await this.acquireLock();
      
      // Reload the latest state before making changes
      const data = fs.readFileSync(this.file, Entry.encoding);
      this.memory = JSON.parse(data, reviver) as T;

      if (!this.memory || Object.values(this.memory).length === 0) {
        this.memory = fields;
      } else {
        Object.entries(fields).forEach(([key, value]) => {
          if (!this.memory[key]) {
            this.memory[key] = value;
          }
        });
      }
      
      await this.publish();
    } finally {
      await this.releaseLock();
    }
  }

  private preflight() {
    /** Ensure cache folder exists */
    if (!fs.existsSync(Entry.folder)) {
      fs.mkdirSync(Entry.folder);
    }
    if (!fs.existsSync(this.file)) {
      fs.writeFileSync(this.file, JSON.stringify({}));
    }
  }

  private async publish() {
    const prepared = JSON.stringify(this.memory, replacer);
    try {
      fs.writeFileSync(this.file, prepared);
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  static resolve(key: string) {
    return path.join(Entry.folder, key.toLowerCase().concat(".json"));
  }
}

