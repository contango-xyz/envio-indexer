import { handlerContext, Token } from "generated/src/Types.gen";
import { Hex } from "viem";
import { createUnderlyingPositionId } from "../ContangoProxy";
import { max, mulDiv } from "../utils/math-helpers";

export const getPositionIdForProxyAddress = async ({ chainId, user, context }: { chainId: number; user: string; context: handlerContext; }) => {
  const underlyingPosition = await context.UnderlyingPositionFactory_UnderlyingPositionCreated.get(createUnderlyingPositionId({ chainId, proxyAddress: user }))
  if (!underlyingPosition) return null
  return underlyingPosition.contangoPositionId as Hex
}

export const getLiquidationPenalty = ({ collateralToken, collateralDelta, debtDelta, referencePrice }: { collateralToken: Token; collateralDelta: bigint; debtDelta: bigint; referencePrice: bigint; }) => {
  const effectivePrice = mulDiv(debtDelta, collateralToken.unit, collateralDelta) // quote unit of instrument
  return mulDiv(referencePrice, BigInt(1e4), effectivePrice) - BigInt(1e4)
}
