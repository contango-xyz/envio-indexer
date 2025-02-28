import { ContangoCollateralEvent, ContangoDebtEvent, ContangoFeeCollectedEvent, ContangoLiquidationEvent, ContangoPositionMigratedEvent, ContangoPositionUpsertedEvent, ContangoSwapEvent, ERC20_Transfer, ERC20_Transfer_event, UnderlyingPositionFactory_UnderlyingPositionCreated, UnderlyingPositionFactory_UnderlyingPositionCreated_event } from "generated";

export enum FillType {
  Open = "Open",
  Close = "Close",
  Modification = "Modification",
  Liquidation = "Liquidation",
  Migration = "Migration",
  Unknown = "Unknown", // use this to indicate that the fill is older than the new events, and needs to be determined in the lots reducer (when we have all of the fills in context)
}

export type ReturnPromiseType<T extends (...args: any) => Promise<any>> = T extends (...args: any) => Promise<infer R> ? R : never

export enum SwapType {
  Trade = "trade",
  Cashflow = "cashflow",
  Unknown = "unknown",
}

export enum EventType {
  SWAP_EXECUTED = "SWAP_EXECUTED",
  FEE_COLLECTED = "FEE_COLLECTED",
  DEBT = "DEBT",
  COLLATERAL = "COLLATERAL",
  POSITION_UPSERTED = "POSITION_UPSERTED",
  TRANSFER = "TRANSFER",
  MIGRATED = "MIGRATED",
  LIQUIDATION = "LIQUIDATION",
  UNDERLYING_POSITION_CREATED = "UNDERLYING_POSITION_CREATED",
}

export type TransferEvent = Exclude<ERC20_Transfer, "eventType"> & { eventType: EventType.TRANSFER };
export type MigratedEvent = Exclude<ContangoPositionMigratedEvent, "eventType"> & { eventType: EventType.MIGRATED };
export type SwapEvent = Exclude<ContangoSwapEvent, "eventType"> & { eventType: EventType.SWAP_EXECUTED };
export type FeeCollectedEvent = Exclude<ContangoFeeCollectedEvent, "eventType"> & { eventType: EventType.FEE_COLLECTED };
export type DebtEvent = Exclude<ContangoDebtEvent, "eventType"> & { eventType: EventType.DEBT };
export type CollateralEvent = Exclude<ContangoCollateralEvent, "eventType"> & { eventType: EventType.COLLATERAL };
export type PositionUpsertedEvent = Exclude<ContangoPositionUpsertedEvent, "eventType"> & { eventType: EventType.POSITION_UPSERTED };
export type LiquidationEvent = Exclude<ContangoLiquidationEvent, "eventType"> & { eventType: EventType.LIQUIDATION };
export type UnderlyingPositionCreated = Exclude<UnderlyingPositionFactory_UnderlyingPositionCreated, "eventType"> & { eventType: EventType.UNDERLYING_POSITION_CREATED };

export type ContangoEvents = 
  | SwapEvent
  | MigratedEvent
  | FeeCollectedEvent
  | DebtEvent
  | CollateralEvent
  | PositionUpsertedEvent
  | LiquidationEvent
  | TransferEvent
  | UnderlyingPositionCreated;

export enum FillItemType {
  Opened = 'Opened',
  Closed = 'Closed',
  ClosedByLiquidation = 'Liquidated (Closed)',
  Modified = 'Modified',
  Liquidated = "Liquidated",
  MigrationClose = "Closed (M)",
  MigrationOpen = "Opened (M)",
}

export type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};