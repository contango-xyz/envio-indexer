import { ContangoFeeCollectedEvent, Maestro, handlerContext } from "generated";
import { getOrCreateFillItem } from "./fillReducers";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { EventType } from "./utils/types";
import { getPairForPositionId, getPosition } from "./utils/common";
import { mulDiv } from "./utils/math-helpers";

export const addFeeEventToFillItem = async ({ feeEvent, context }: { feeEvent: ContangoFeeCollectedEvent; context: handlerContext; }) => {
  const position = await getPosition({ chainId: feeEvent.chainId, positionId: feeEvent.positionId, context })
  const fillItem = await getOrCreateFillItem({ ...feeEvent, positionId: feeEvent.positionId, context })
  const { collateralToken, debtToken } = await getPairForPositionId({ chainId: feeEvent.chainId, positionId: feeEvent.positionId, context })

  fillItem.fee = feeEvent.amount
  fillItem.feeToken_id = feeEvent.token_id

  if (feeEvent.token_id === collateralToken.id) {
    fillItem.fee_short = feeEvent.amount
    fillItem.fee_long = mulDiv(feeEvent.amount, fillItem.tradePrice_long, collateralToken.unit)
  } else if (feeEvent.token_id === debtToken.id) {
    fillItem.fee_long = feeEvent.amount
    fillItem.fee_short = mulDiv(feeEvent.amount, fillItem.tradePrice_short, debtToken.unit)
  }

  // because the fee collection happens after the position upserted event, we have to re-upsert the position and the fill item
  context.FillItem.set(fillItem)
  context.Position.set({ ...position, fees_long: position.fees_long + fillItem.fee_long, fees_short: position.fees_short + fillItem.fee_short })
};

Maestro.FeeCollected.handler(async ({ event, context }) => {
  const token = await getOrCreateToken({ chainId: event.chainId, address: event.params.token, context })
  const entity: ContangoFeeCollectedEvent = {
    id: createEventId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex, eventType: EventType.FEE_COLLECTED }),
    eventType: EventType.FEE_COLLECTED,
    chainId: event.chainId,
    positionId: event.params.positionId,
    trader: event.params.trader,
    treasury: event.params.treasury,
    token_id: token.id,
    amount: event.params.amount,
    basisPoints: Number(event.params.basisPoints),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  }

  context.ContangoFeeCollectedEvent.set(entity)

  await addFeeEventToFillItem({ feeEvent: entity, context })
})
