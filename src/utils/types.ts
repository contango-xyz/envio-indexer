import { ContangoSwapEvent, ContangoLiquidationEvent, ContangoPositionMigratedEvent, ContangoFeeCollectedEvent, ContangoDebtEvent, ContangoCollateralEvent, ContangoPositionUpsertedEvent, ERC20_Transfer_event } from "generated";

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
  POSITION_UPSERTED = "POSITION_UPSERTED",
  SWAP_EXECUTED = "SWAP_EXECUTED",
  FEE_COLLECTED = "FEE_COLLECTED",
  MIGRATED = "MIGRATED",
  LIQUIDATION = "LIQUIDATION",
  DEBT = "DEBT",
  COLLATERAL = "COLLATERAL",
  UNKNOWN = "UNKNOWN"
}

export type ContangoEvents = ContangoSwapEvent |
  ContangoLiquidationEvent |
  ContangoPositionMigratedEvent |
  ContangoFeeCollectedEvent |
  ContangoDebtEvent |
  ContangoCollateralEvent |
  ContangoPositionUpsertedEvent;

export enum MoneyMarket {
  Aave = 1,
  Compound = 2,
  Yield = 3,
  Exactly = 4,
  Sonne = 5,
  Maker = 6,
  Spark = 7,
  MorphoBlue = 8,
  Agave = 9,
  AaveV2 = 10,
  Radiant = 11,
  Lodestar = 12,
  Moonwell = 13,
  Comet = 14,
  Granary = 15,
  Silo = 16,
  Dolomite = 17,
  ZeroLend = 18,
  AaveLido = 19,
  LayerBank = 20,
  RhoMarkets = 21,
  InitCapital = 22,
  Mendi = 23,
  Benqi = 24,
  Lendle = 25,
  Methlab = 26,
  Minterest = 27,
  Silo2 = 28,
  AaveEtherFi = 29,
  Euler = 30,
  Fluid = 31,
  ZeroLendBTC = 32,
  SparkSky = 33,
  ZeroLendRWA = 34,
  SiloBTC = 35,
}

export type GenericEvent = {
  chainId: number
  blockNumber: number
  transactionHash: string
  blockTimestamp: number
  logIndex: number
}

export enum FillItemType {
  Trade = "Trade",
  Liquidation = "Liquidation",
}