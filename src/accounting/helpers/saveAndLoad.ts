import { FillItem, Lot, Position, TVL, Token, handlerContext } from "generated/src/Types.gen";
import { createIdForLot } from "../../utils/ids";
import { ReferencePriceSource } from "./prices";
import { max } from "../../utils/math-helpers";

export const saveFillItem = (fillItem: FillItem, context: handlerContext) => {
  if (fillItem.referencePriceSource === ReferencePriceSource.None && fillItem.cashflow !== 0n) {
    throw new Error(`Fill item has no reference price source: ${fillItem.transactionHash} chainId: ${fillItem.chainId}`)
  }
  context.FillItem.set(fillItem)
}

export const savePosition = ({ position, lots, context }: { position: Position; lots: Lot[]; context: handlerContext }) => {

  let openLotCount = 0
  for (const lot of lots) {
    if (lot.contangoPositionId !== position.contangoPositionId) {
      throw new Error(`Lot ${lot.id} has a different position id than the one provided: ${lot.contangoPositionId} !== ${position.id}`)
    }

    if (lot.size) {
      const id = createIdForLot({ chainId: lot.chainId, positionId: lot.contangoPositionId, index: openLotCount })
      context.Lot.set({ ...lot, id })
      openLotCount++
      continue
    } else {
      // size is zero, so it's a closed lot. closed lots cannot have an open cost!
      if (lot.openCost) throw new Error(`Lot ${lot.id} is closed but has an open cost: ${lot.openCost}`)
    }
  }

  // delete lots that were closed. First lot is index 0, so in the case where lots are being closed,
  // we need to delete the lot indexes that are to the right of the last open lot.
  for (let i = openLotCount; i < position.lotCount; i++) {
    const id = createIdForLot({ chainId: position.chainId, positionId: position.contangoPositionId, index: i })
    context.Lot.deleteUnsafe(id)
  }

  context.Position.set({ ...position, lotCount: openLotCount })
}

export const loadLots = async ({ position, context }: { position: Position; context: handlerContext; }) => {

  return (await Promise.all(Array.from({ length: position.lotCount }, async (_, idx) => {
    return context.Lot.get(createIdForLot({ chainId: position.chainId, positionId: position.contangoPositionId, index: idx }));
  }))).filter((lot): lot is Lot => Boolean(lot));

};

export const updateTvl = async ({ position, quoteToken, newCashflowQuote, oldCashflowQuote, context }: { quoteToken: Token; position: Position; newCashflowQuote: bigint; oldCashflowQuote: bigint; context: handlerContext }) => {
  const delta = max(newCashflowQuote, 0n) - max(oldCashflowQuote, 0n)
  const id = `${position.chainId}_${quoteToken.address}`
  const tvl = await context.TVL.get(id)
  const entry: TVL = {
    id,
    chainId: position.chainId,
    token_id: quoteToken.id,
    tvl: max((tvl?.tvl || 0n) + delta, 0n),
  }
  context.TVL.set(entry)
}
