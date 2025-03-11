import { AaveLiquidations_LiquidateAave_event, AaveLiquidations_LiquidateAgave_event, AaveLiquidations_LiquidateRadiant_event, BeginStrategyEvent, ContangoCollateralEvent, ContangoDebtEvent, ContangoFeeCollectedEvent, ContangoLiquidationEvent, ContangoPositionMigratedEvent, ContangoPositionUpsertedEvent, ContangoSwapEvent, ERC20_Transfer, ERC20_Transfer_event, EndStrategyEvent, PositionNFT_Transfer, UnderlyingPositionFactory_UnderlyingPositionCreated, UnderlyingPositionFactory_UnderlyingPositionCreated_event } from "generated";

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
  TRANSFER_NFT = "TRANSFER_NFT",
  END_STRATEGY = "END_STRATEGY",
  BEGIN_STRATEGY = "BEGIN_STRATEGY",
}

export enum MigrationType {
  MigrateLendingMarket = "Migrate - Lending Market",
  MigrateBaseCurrency = "Migrate - Base Currency",
  MigrateQuoteCurrency = "Migrate - Quote Currency",
}

export type TransferNFT = Exclude<PositionNFT_Transfer, "eventType"> & { eventType: EventType.TRANSFER_NFT };
export type TransferEvent = Exclude<ERC20_Transfer, "eventType"> & { eventType: EventType.TRANSFER };
export type SwapEvent = Exclude<ContangoSwapEvent, "eventType"> & { eventType: EventType.SWAP_EXECUTED };
export type FeeCollectedEvent = Exclude<ContangoFeeCollectedEvent, "eventType"> & { eventType: EventType.FEE_COLLECTED };
export type DebtEvent = Exclude<ContangoDebtEvent, "eventType"> & { eventType: EventType.DEBT };
export type CollateralEvent = Exclude<ContangoCollateralEvent, "eventType"> & { eventType: EventType.COLLATERAL };
export type PositionUpsertedEvent = Exclude<ContangoPositionUpsertedEvent, "eventType"> & { eventType: EventType.POSITION_UPSERTED };
export type LiquidationEvent = Exclude<ContangoLiquidationEvent, "eventType"> & { eventType: EventType.LIQUIDATION };
export type UnderlyingPositionCreated = Exclude<UnderlyingPositionFactory_UnderlyingPositionCreated, "eventType"> & { eventType: EventType.UNDERLYING_POSITION_CREATED };
export type PositionMigratedEvent = Exclude<ContangoPositionMigratedEvent, "eventType"> & { eventType: EventType.MIGRATED };
export type EndStrategy = Exclude<EndStrategyEvent, "eventType"> & { eventType: EventType.END_STRATEGY };
export type BeginStrategy = Exclude<BeginStrategyEvent, "eventType"> & { eventType: EventType.BEGIN_STRATEGY };

export type ContangoEvents = 
  | SwapEvent
  | FeeCollectedEvent
  | DebtEvent
  | CollateralEvent
  | PositionUpsertedEvent
  | LiquidationEvent
  | TransferEvent
  | TransferNFT
  | PositionMigratedEvent
  | BeginStrategy
  | EndStrategy
  | UnderlyingPositionCreated;

export enum FillItemType {
  Opened = 'Opened',
  Closed = 'Closed',
  Liquidated = 'Liquidated',
  LiquidatedFully = 'LiquidatedFully',
  Modified = 'Modified',
  MigrateLendingMarket = "Migrate - Lending Market",
  MigrateBaseCurrencyClose = "Migrate - Swap Collateral (Close)",
  MigrateBaseCurrencyOpen = "Migrate - Swap Collateral (Open)",
}

export type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};
export enum CashflowCurrency {
  None,
  Base,
  Quote
}
