import {
  AaveLiquidations,
  AaveLiquidations_LiquidateAave_event,
  AaveLiquidations_LiquidateAgave_event,
  AaveLiquidations_LiquidateRadiant_event,
  ContangoLiquidationEvent,
  handlerContext
} from "generated";
import { Hex, getContract, parseAbi } from "viem";
import { GenericEvent } from "../accounting/lotsAccounting";
import { eventProcessor } from "../accounting/processTransactions";
import { clients } from "../clients";
import { getInterestToSettleOnLiquidation } from "../utils/common";
import { createEventId } from "../utils/ids";
import { positionIdMapper } from "../utils/mappers";
import { mulDiv } from "../utils/math-helpers";
import { EventType, LiquidationEvent } from "../utils/types";
import { getPositionForProxy } from "./common";

// Aave
export function getLiquidationBonus(data: bigint): bigint {
  // 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF0000FFFFFFFF
  const LIQUIDATION_BONUS_MASK = 115792089237316195423570985008687907853269984665640564039457583726442447896575n
  const LIQUIDATION_BONUS_START_BIT_POSITION = 32n

  // Max uint256 value
  const UINT256_MAX = 2n ** 256n - 1n
  const maskNegated = UINT256_MAX ^ LIQUIDATION_BONUS_MASK

  return (data & maskNegated) >> LIQUIDATION_BONUS_START_BIT_POSITION
}

export function getLiquidationProtocolFee(data: bigint): bigint {
  // 0xFFFFFFFFFFFFFFFFFFFFFF0000FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF
  const LIQUIDATION_PROTOCOL_FEE_MASK = 115792089237316195423570984634549197687329661445021480007966928956539929624575n
  const LIQUIDATION_PROTOCOL_FEE_START_BIT_POSITION = 152n

  // Max uint256 value
  const UINT256_MAX = 2n ** 256n - 1n
  const maskNegated = UINT256_MAX ^ LIQUIDATION_PROTOCOL_FEE_MASK

  return (data & maskNegated) >> LIQUIDATION_PROTOCOL_FEE_START_BIT_POSITION
}

const aaveAbi = parseAbi([
  "function ADDRESSES_PROVIDER() external view returns (address)",
  "struct ReserveConfigurationMap { uint256 data; }",
  "function getConfiguration(address asset) external view returns (ReserveConfigurationMap memory)",
])

export const processAaveLiquidationEvents = async (
{ event, chainId, positionId, collateralAsset, liquidationContractAddress, blockNumber, liquidatedCollateralAmount, debtToCover, isV3 }: { event: GenericEvent; chainId: number; positionId: string; collateralAsset: Hex; liquidationContractAddress: Hex; blockNumber: bigint; liquidatedCollateralAmount: bigint; debtToCover: bigint; isV3: boolean; },
): Promise<Omit<ContangoLiquidationEvent, 'cashflowInDebtToken' | 'liquidationPenalty' | 'markPrice' | 'eventType' | 'debtCostToSettle' | 'lendingProfitToSettle' | 'blockTimestamp' | 'transactionHash'>> => {
  const client = clients[chainId]

  const pool = getContract({ abi: aaveAbi, address: liquidationContractAddress as Hex, client })
  let data = 0n
  try {
    data = (await pool.read.getConfiguration([collateralAsset], { blockNumber: BigInt(blockNumber) })).data
  } catch {
    data = (await pool.read.getConfiguration([collateralAsset])).data
  }
  const liquidationBonus = getLiquidationBonus(data) - BigInt(1e4) // e.g. from 105% to 5%
  const liquidationProtocolFeePercentage = isV3 ? getLiquidationProtocolFee(data) : 0n

  const normalisedProtocolFeePercentage = mulDiv(liquidationProtocolFeePercentage, liquidationBonus, BigInt(1e4))

  // normalisedProtocolFeePercentage = protocolFee * liquidationBonus
  // protocolFee = liquidatedCollateralAmount / (1 + liquidationBonus - normalisedProtocolFeePercentage) * normalisedProtocolFeePercentage
  let protocolFee = mulDiv(liquidatedCollateralAmount, BigInt(1e4), BigInt(1e4) + liquidationBonus - normalisedProtocolFeePercentage)
  protocolFee = mulDiv(protocolFee, normalisedProtocolFeePercentage, BigInt(1e4))

  const collateralTaken = liquidatedCollateralAmount + protocolFee

  return {
    id: createEventId({ ...event, eventType: EventType.LIQUIDATION }),
    chainId,
    contangoPositionId: positionId,
    collateralDelta: -collateralTaken,
    debtDelta: -debtToCover,
    blockNumber: Number(blockNumber),
  }
}

const isV3 = (mm: number) => ![10, 9, 11, 15].includes(mm)

type AaveLiquidationEvent = AaveLiquidations_LiquidateAave_event | AaveLiquidations_LiquidateAgave_event | AaveLiquidations_LiquidateRadiant_event

const processAndSaveLiquidation = async (event: AaveLiquidationEvent, collateralAsset: string, context: handlerContext) => {
  const position = await getPositionForProxy({ chainId: event.chainId, proxyAddress: event.params.user, context })
  if (!position) return
  const { lendingProfitToSettle, debtCostToSettle } = await getInterestToSettleOnLiquidation({ chainId: event.chainId, blockNumber: event.block.number, position })

  const aaveLiquidationEvent = await processAaveLiquidationEvents({
    chainId: event.chainId,
    positionId: position.contangoPositionId,
    collateralAsset: collateralAsset as Hex,
    liquidationContractAddress: event.srcAddress as Hex,
    blockNumber: BigInt(event.block.number),
    liquidatedCollateralAmount: event.params.liquidatedCollateralAmount,
    debtToCover: event.params.debtToCover,
    isV3: isV3(positionIdMapper(position.contangoPositionId).mm),
    event,
  })

  try {

    const liquidationEvent: LiquidationEvent = {
      ...aaveLiquidationEvent,
      lendingProfitToSettle,
      blockTimestamp: event.block.timestamp,
      debtCostToSettle,
      transactionHash: event.transaction.hash,
      cashflowInDebtToken: 0n,
      eventType: EventType.LIQUIDATION,
    }

    await eventProcessor.processEvent(liquidationEvent, context)

  } catch (e) {
    console.error(e)
    context.log.debug(`Error processing liquidation for positionId: ${position.contangoPositionId} lendingProfitToSettle: ${lendingProfitToSettle} debtCostToSettle: ${debtCostToSettle}`)
  }
}

AaveLiquidations.LiquidateAave.handler(async ({ event, context }) => {
  await processAndSaveLiquidation(event, event.params.collateralAsset, context)
}, { wildcard: true });

AaveLiquidations.LiquidateAgave.handler(async ({ event, context }) => {
  await processAndSaveLiquidation(event, event.params.collateralAsset, context)
}, { wildcard: true });

AaveLiquidations.LiquidateRadiant.handler(async ({ event, context }) => {
  await processAndSaveLiquidation(event, event.params.collateral, context)
}, { wildcard: true });