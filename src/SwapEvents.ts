import { ContangoSwapEvent, SimpleSpotExecutor, SpotExecutor } from "generated";
import { eventStore } from "./Store";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { absolute } from "./utils/math-helpers";
import { EventType } from "./utils/types";

const knownToAddresses = new Set([
  '0xa64f0dbb10c473978c2efe069da207991e8e3cb3', // order manager
  '0xa6a147946facac9e0b99824870b36088764f969f', // maestro
  '0xc2462f03920d47fc5b9e2c5f0ba5d2ded058fd78', // position nft
  '0x5bdeb2152f185bf59f2de027cbb05355cc965bd', // strategy proxy
])

SpotExecutor.SwapExecuted.handler(async ({ event, context }) => {
  if (event.transaction.to &&!knownToAddresses.has(event.transaction.to.toLowerCase())) return

  const [tokenIn, tokenOut] = await Promise.all([
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToSell, context }),
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToBuy, context }),
  ])

  const { chainId, block: { timestamp: blockTimestamp, number: blockNumber }, transaction: { hash: transactionHash }, logIndex } = event
  const eventId = createEventId({ chainId, blockNumber, transactionHash, logIndex, eventType: EventType.SWAP_EXECUTED })
  const swapEvent: ContangoSwapEvent = {
    id: eventId,
    chainId,
    tokenIn_id: tokenIn.id,
    tokenOut_id: tokenOut.id,
    amountIn: absolute(event.params.amountIn),
    amountOut: absolute(event.params.amountOut),
    blockNumber,
    blockTimestamp,
    transactionHash,
  }

  context.ContangoSwapEvent.set(swapEvent)
  eventStore.addLog({ eventId, contangoEvent: { ...swapEvent, eventType: EventType.SWAP_EXECUTED } })
}, { wildcard: true })

SimpleSpotExecutor.SwapExecuted.handler(async ({ event, context }) => {

  if (event.transaction.to &&!knownToAddresses.has(event.transaction.to.toLowerCase())) return

  const [tokenIn, tokenOut] = await Promise.all([
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToSell, context }),
    getOrCreateToken({ chainId: event.chainId, address: event.params.tokenToBuy, context }),
  ])

  const eventId = createEventId({ chainId: event.chainId, blockNumber: event.block.number, transactionHash: event.transaction.hash, logIndex: event.logIndex, eventType: EventType.SWAP_EXECUTED })

  const swapEvent: ContangoSwapEvent = {
    id: eventId,
    chainId: event.chainId,
    tokenIn_id: tokenIn.id,
    tokenOut_id: tokenOut.id,
    amountIn: absolute(event.params.amountIn),
    amountOut: absolute(event.params.amountOut),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    transactionHash: event.transaction.hash,
  }

  context.ContangoSwapEvent.set(swapEvent)
  eventStore.addLog({ eventId, contangoEvent: { ...swapEvent, eventType: EventType.SWAP_EXECUTED } })
}, { wildcard: true })
