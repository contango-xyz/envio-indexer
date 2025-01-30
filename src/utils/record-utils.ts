type RecordKeys = <K extends string | number>(o: Record<K, any>) => K[]
export const recordKeys: RecordKeys = Object.keys

type RecordEntries = <K extends string | number, T>(o: Record<K, T>) => [K, T][]
export const recordEntries: RecordEntries = Object.entries

type RecordFromEntries = <K extends string | number, T>(input: (readonly [K, T] | [K, T])[]) => Record<K, T>
export const recordFromEntries: RecordFromEntries = Object.fromEntries
