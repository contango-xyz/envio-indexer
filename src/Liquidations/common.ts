import { handlerContext, Token } from "generated/src/Types.gen";
import { Hex } from "viem";
import { createUnderlyingPositionId } from "../ContangoProxy";
import { mulDiv } from "../utils/math-helpers";
import { createIdForPosition } from "../utils/ids";

export const getPositionIdForProxyAddress = async ({ chainId, user, context }: { chainId: number; user: string; context: handlerContext; }) => {
  const underlyingPosition = await context.UnderlyingPositionFactory_UnderlyingPositionCreated.get(createUnderlyingPositionId({ chainId, proxyAddress: user }))
  if (!underlyingPosition) return null
  return underlyingPosition.contangoPositionId as Hex
}

export const getLiquidationPenalty = ({ collateralToken, collateralDelta, debtDelta, cashflowQuote, referencePrice }: { cashflowQuote: bigint; collateralToken: Token; collateralDelta: bigint; debtDelta: bigint; referencePrice: bigint; }) => {
  const effectivePrice = mulDiv(debtDelta + cashflowQuote, collateralToken.unit, collateralDelta) // quote unit of instrument
  return mulDiv(referencePrice, BigInt(1e4), effectivePrice) - BigInt(1e4)
}

export const getPositionForProxy = async ({ chainId, proxyAddress, context }: { chainId: number; proxyAddress: string; context: handlerContext; }) => {
  const contangoPositionId = await getPositionIdForProxyAddress({ chainId, user: proxyAddress, context })
  if (!contangoPositionId) return null
  return await context.Position.get(createIdForPosition({ chainId, contangoPositionId }))
}
