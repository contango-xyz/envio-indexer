import {
  AaveLiquidations,
  AaveLiquidations_LiquidateAave_event,
  AaveLiquidations_LiquidateAgave_event,
  AaveLiquidations_LiquidateRadiant_event,
  ContangoLiquidationEvent,
  handlerContext
} from "generated";
import { getContract, Hex, parseAbi } from "viem";
import { clients } from "../clients";
import { positionIdMapper } from "../utils/mappers";
import { mulDiv } from "../utils/math-helpers";
import { getMarkPrice, getPositionIdForProxyAddress, createLiquidationFillItem } from "./common";
import { createLiquidationId } from "../utils/ids";
import { getBalancesAtBlock } from "../utils/common";
import { EventType, MoneyMarket } from "../utils/types";

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
{ chainId, positionId, txHash, logIndex, collateralAsset, liquidationContractAddress, blockNumber, liquidatedCollateralAmount, debtToCover, liquidator, user, isV3 }: { chainId: number; positionId: Hex; txHash: Hex; logIndex: number; collateralAsset: Hex; liquidationContractAddress: Hex; blockTimestamp: number; blockNumber: bigint; liquidatedCollateralAmount: bigint; debtToCover: bigint; liquidator: Hex; user: Hex; isV3: boolean; },
): Promise<Omit<ContangoLiquidationEvent, 'srcContract' | 'markPrice' | 'eventType' | 'debtBefore' | 'collateralBefore' | 'blockTimestamp' | 'transactionHash'>> => {
  const client = clients[chainId]

  const pool = getContract({ abi: aaveAbi, address: liquidationContractAddress as Hex, client })
  const { data } = await pool.read.getConfiguration([collateralAsset], { blockNumber: BigInt(blockNumber) })

  const liquidationBonus = getLiquidationBonus(data) - BigInt(1e4) // e.g. from 105% to 5%
  const liquidationProtocolFeePercentage = isV3 ? getLiquidationProtocolFee(data) : 0n

  const normalisedProtocolFeePercentage = mulDiv(liquidationProtocolFeePercentage, liquidationBonus, BigInt(1e4))

  // normalisedProtocolFeePercentage = protocolFee * liquidationBonus
  // protocolFee = liquidatedCollateralAmount / (1 + liquidationBonus - normalisedProtocolFeePercentage) * normalisedProtocolFeePercentage
  let protocolFee = mulDiv(liquidatedCollateralAmount, BigInt(1e4), BigInt(1e4) + liquidationBonus - normalisedProtocolFeePercentage)
  protocolFee = mulDiv(protocolFee, normalisedProtocolFeePercentage, BigInt(1e4))

  const collateralTaken = liquidatedCollateralAmount + protocolFee

  return {
    id: createLiquidationId({ chainId, blockNumber: Number(blockNumber), transactionHash: txHash, logIndex: Number(logIndex) }),
    chainId,
    positionId,
    collateralTaken,
    debtRepaid: debtToCover,
    tradedBy: liquidator.toLowerCase() as Hex,
    proxy: user.toLowerCase() as Hex,
    blockNumber: Number(blockNumber),
  }
}

const isV3 = (mm: MoneyMarket) => ![MoneyMarket.AaveV2, MoneyMarket.Agave, MoneyMarket.Radiant, MoneyMarket.Granary].includes(mm)

type LiquidationEvent = AaveLiquidations_LiquidateAave_event | AaveLiquidations_LiquidateAgave_event | AaveLiquidations_LiquidateRadiant_event

const processAndSaveLiquidation = async (event: LiquidationEvent, collateralAsset: string, context: handlerContext) => {
  const positionId = await getPositionIdForProxyAddress({ chainId: event.chainId, user: event.params.user, context })
  if (positionId) {
    const balancesBefore = await getBalancesAtBlock(event.chainId, positionId, event.block.number - 1)
    const aaveLiquidationEvent = await processAaveLiquidationEvents({
      chainId: event.chainId,
      positionId,
      collateralAsset: collateralAsset as Hex,
      liquidationContractAddress: event.srcAddress as Hex,
      blockNumber: BigInt(event.block.number),
      liquidatedCollateralAmount: event.params.liquidatedCollateralAmount,
      debtToCover: event.params.debtToCover,
      liquidator: event.params.liquidator as Hex,
      user: event.params.user as Hex,
      isV3: isV3(positionIdMapper(positionId).mm),
      txHash: event.transaction.hash as Hex,
      logIndex: event.logIndex,
      blockTimestamp: Number(event.block.timestamp),
    })

    const markPrice = await getMarkPrice({ chainId: event.chainId, positionId, blockNumber: event.block.number, context })
    
    const liquidationEvent: ContangoLiquidationEvent = {
      eventType: EventType.LIQUIDATION,
      ...aaveLiquidationEvent,
      collateralBefore: balancesBefore.collateral,
      debtBefore: balancesBefore.debt,
      blockTimestamp: event.block.timestamp,
      transactionHash: event.transaction.hash,
      markPrice,
      srcContract: event.srcAddress,
    }
    context.ContangoLiquidationEvent.set(liquidationEvent)

    await createLiquidationFillItem({ liquidationEvent, context })
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