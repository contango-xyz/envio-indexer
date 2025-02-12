import { ContangoLiquidationEvent, handlerContext } from "generated/src/Types.gen";
import { Hex, getContract } from "viem";
import { createUnderlyingPositionId } from "../ContangoProxy";
import { accrueInterest, loadLots, processCollateralDelta, processDebtDelta } from "../accounting/lots";
import { clients } from "../clients";
import { getOrCreateFillItem } from "../fillReducers";
import { getPairForPositionId, getPosition, lensAbi, lensAddress } from "../utils/common";
import { max, mulDiv } from "../utils/math-helpers";
import { FillItemType } from "../utils/types";

export const getPositionIdForProxyAddress = async ({ chainId, user, context }: { chainId: number; user: string; context: handlerContext; }) => {
  const underlyingPosition = await context.UnderlyingPositionFactory_UnderlyingPositionCreated.get(createUnderlyingPositionId({ chainId, proxyAddress: user }))
  if (!underlyingPosition) return null
  return underlyingPosition.positionId as Hex
}

export const createLiquidationFillItem = async ({ liquidationEvent, context }: { liquidationEvent: ContangoLiquidationEvent; context: handlerContext; }) => {

  const { collateralBefore, debtBefore, debtRepaid, collateralTaken, blockNumber, blockTimestamp, transactionHash, chainId, positionId } = liquidationEvent

  const position = await getPosition({ chainId, positionId, context })
  const fillItem = await getOrCreateFillItem({ chainId, blockNumber, positionId, transactionHash, blockTimestamp, context })
  
  const { collateralToken } = await getPairForPositionId({ chainId, positionId, context })
  const newFillItem = { ...fillItem }
  

  const debtDelta = -debtRepaid
  const collateralDelta = -collateralTaken
  const effectivePrice = mulDiv(debtDelta, collateralToken.unit, collateralDelta) // quote unit of instrument

  // update fill item
  newFillItem.fillItemType = FillItemType.Liquidation
  newFillItem.liquidationPenalty = max(mulDiv(liquidationEvent.markPrice, BigInt(1e4), effectivePrice) - BigInt(1e4), 0n)
  context.FillItem.set(newFillItem)

  // accrue interest
  try {
    const debtCostToSettle = debtBefore - (position.debt + position.accruedInterest)
    const lendingProfitToSettle = collateralBefore - (position.collateral + position.accruedLendingProfit)
    let lots = await loadLots({ position, context })
    lots = await accrueInterest({ context, debtCostToSettle, lendingProfitToSettle, lots })
  
    // process deltas
    await processCollateralDelta({ context, chainId, collateralDelta, position, blockNumber, transactionHash, blockTimestamp, lots })
    await processDebtDelta({ context, chainId, position, blockNumber, transactionHash, blockTimestamp, debtDelta, lots })
  } catch {
    context.log.debug(`${debtBefore} - (${position.debt} + ${position.accruedInterest})`)
  }

}

export const getMarkPrice = async ({ chainId, positionId, blockNumber, context }: { chainId: number; positionId: Hex; blockNumber: number; context: handlerContext }): Promise<bigint> => {
  try {
    const { debtToken } = await getPairForPositionId({ chainId, positionId, context })
    const lens = getContract({ abi: lensAbi, address: lensAddress, client: clients[chainId] })
    const prices = await lens.read.prices([positionId], { blockNumber: BigInt(blockNumber) })
    return mulDiv(prices.collateral, debtToken.unit, prices.debt)
  } catch {
    return 0n
  }
}
