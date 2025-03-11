import { SimpleSpotExecutor, SpotExecutor } from "generated";
import { eventProcessor } from "./accounting/processTransactions";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { absolute } from "./utils/math-helpers";
import { EventType, SwapEvent } from "./utils/types";

SpotExecutor.SwapExecuted.handler(async ({ event, context }) => {
  const [tokenIn, tokenOut] = await Promise.all([
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToSell, context }),
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToBuy, context }),
  ])

  const { chainId, block: { timestamp: blockTimestamp, number: blockNumber }, transaction: { hash: transactionHash }, logIndex } = event
  const eventId = createEventId({ ...event, eventType: EventType.SWAP_EXECUTED })
  const swapEvent: SwapEvent = {
    id: eventId,
    chainId,
    tokenIn_id: tokenIn.id,
    tokenOut_id: tokenOut.id,
    amountIn: absolute(event.params.amountIn),
    amountOut: absolute(event.params.amountOut),
    blockNumber,
    blockTimestamp,
    transactionHash,
    eventType: EventType.SWAP_EXECUTED,
  }

  await eventProcessor.processEvent(swapEvent, context)
})

SimpleSpotExecutor.SwapExecuted.handler(async ({ event, context }) => {

  const [tokenIn, tokenOut] = await Promise.all([
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToSell, context }),
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToBuy, context }),
  ])

  const eventId = createEventId({ ...event, eventType: EventType.SWAP_EXECUTED })

  const swapEvent: SwapEvent = {
    id: eventId,
    chainId: event.chainId,
    tokenIn_id: tokenIn.id,
    tokenOut_id: tokenOut.id,
    amountIn: absolute(event.params.amountIn),
    amountOut: absolute(event.params.amountOut),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
    eventType: EventType.SWAP_EXECUTED,
  }

  await eventProcessor.processEvent(swapEvent, context)
})
