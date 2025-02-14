import { handlerContext, Token } from "generated/src/Types.gen";
import { getContract, Hex } from "viem";
import { createUnderlyingPositionId } from "../ContangoProxy";
import { clients } from "../clients";
import { getPairForPositionId, lensAbi, lensAddress } from "../utils/common";
import { max, mulDiv } from "../utils/math-helpers";

export const getPositionIdForProxyAddress = async ({ chainId, user, context }: { chainId: number; user: string; context: handlerContext; }) => {
  const underlyingPosition = await context.UnderlyingPositionFactory_UnderlyingPositionCreated.get(createUnderlyingPositionId({ chainId, proxyAddress: user }))
  if (!underlyingPosition) return null
  return underlyingPosition.positionId as Hex
}

export const getLiquidationPenalty = ({ collateralToken, collateralDelta, debtDelta, markPrice }: { collateralToken: Token; collateralDelta: bigint; debtDelta: bigint; markPrice: bigint; }) => {
  const effectivePrice = mulDiv(debtDelta, collateralToken.unit, collateralDelta) // quote unit of instrument
  return max(mulDiv(markPrice, BigInt(1e4), effectivePrice) - BigInt(1e4), 0n)
}

export const getMarkPrice = async ({ chainId, positionId, blockNumber, debtToken }: { debtToken: Token; chainId: number; positionId: Hex; blockNumber: number }): Promise<bigint> => {
  try {
    const lens = getContract({ abi: lensAbi, address: lensAddress, client: clients[chainId] })
    const prices = await lens.read.prices([positionId], { blockNumber: BigInt(blockNumber) })
    return mulDiv(prices.collateral, debtToken.unit, prices.debt)
  } catch {
    return 0n
  }
}
