import {
  ContangoProxy,
  Instrument,
  PositionNFT,
  UnderlyingPositionFactory,
  UnderlyingPositionFactory_UnderlyingPositionCreated
} from "generated";
import { Hex, toHex, zeroAddress } from "viem";
import { createPosition } from "./accounting/positions";
import { eventStore } from "./Store";
import { createInstrumentId, getPositionSafe } from "./utils/common";
import { getOrCreateToken } from "./utils/getTokenDetails";
import { createEventId } from "./utils/ids";
import { strategyContractsAddresses } from "./utils/previousContractAddresses";
import { EventType, PositionUpsertedEvent } from "./utils/types";

// re-run
ContangoProxy.PositionUpserted.handler(async ({ event, context }) => {
  const contangoEvent: PositionUpsertedEvent = {
    ...event.params,
    contangoPositionId: event.params.positionId,
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    chainId: event.chainId,
    id: createEventId({ ...event, eventType: EventType.POSITION_UPSERTED }),
    transactionHash: event.transaction.hash,
    eventType: EventType.POSITION_UPSERTED,
  }
  eventStore.addLog({ event, contangoEvent })

  await eventStore.getCurrentPositionSnapshot({ event, context })
})

// On create, the NFT transfer event is emitted before the UnderlyingPositionCreated event
PositionNFT.Transfer.handler(async ({ event, context }) => {
  const positionId = toHex(event.params.tokenId, { size: 32 }).toLowerCase() as Hex
  const [to, from] = [event.params.to, event.params.from].map(address => address.toLowerCase()) as Hex[]

  if (event.srcAddress.toLowerCase() !== '0xc2462f03920d47fc5b9e2c5f0ba5d2ded058fd78') return; // bug in envio causing this handler to pick up some scam tsx for example on this tx hash: 0xc1d5865badca9ee1f7d787c1d69f42621dd10a6ac8affad2d8d3d89ce9393ae2

  if (event.params.from !== zeroAddress) {
    // if the transfer is to the strategy builder, we don't update the owner.
    // This is important because when we evaluate cashflows, we need to know the cashflows of the actual owner and not the "temporary" owner
    const isTransferToStrategyBuilder = strategyContractsAddresses(event.chainId).has(to)

    const position = await getPositionSafe({ chainId: event.chainId, positionId, context })

    if (position) {
      const owner = isTransferToStrategyBuilder || to === zeroAddress ? position.owner : to
      const isOpen = to !== zeroAddress // update isOpen when NFT is transferred to the zero address
  
      context.Position.set({ ...position, owner, isOpen })
    } else {
      if (!strategyContractsAddresses(event.chainId).has(from)) throw new Error(`Position not found for NFT transfer event. tx hash: ${event.transaction.hash}`)
      
      return;
      // if no position exists yet, it means we're in a migration transaction and it'll be handled by the eventsReducer()
    }
  }
});

export const createUnderlyingPositionId = ({ chainId, proxyAddress }: { chainId: number; proxyAddress: string; }) => `${chainId}_${proxyAddress.toLowerCase()}`

UnderlyingPositionFactory.UnderlyingPositionCreated.handler(async ({ event, context }) => {
  if (!event.transaction.from) throw new Error('UnderlyingPositionCreated event has no from address')
  const [owner, proxyAddress] = [event.transaction.from, event.params.account].map(address => address.toLowerCase())
  await createPosition({ ...event, positionId: event.params.positionId, owner, proxyAddress, context })

  const underlyingPosition: UnderlyingPositionFactory_UnderlyingPositionCreated = {
    id: createUnderlyingPositionId({ chainId: event.chainId, proxyAddress }),
    contangoPositionId: event.params.positionId,
    account: event.params.account.toLowerCase(),
    blockNumber: event.block.number,
    blockTimestamp: event.block.timestamp,
    chainId: event.chainId,
    transactionHash: event.transaction.hash,
  }

  context.UnderlyingPositionFactory_UnderlyingPositionCreated.set(underlyingPosition)
});


ContangoProxy.InstrumentCreated.handler(async ({ event, context }) => {
  const { chainId, params } = event
  const [collateralToken, debtToken] = await Promise.all([
    getOrCreateToken({ address: params.base, chainId, context }),
    getOrCreateToken({ address: params.quote, chainId, context }),
  ]);

  const instrumentId = event.params.symbol.slice(0, 34)

  const entity: Instrument = {
    id: createInstrumentId({ chainId, instrumentId }),
    chainId: event.chainId,
    instrumentId,
    collateralToken_id: collateralToken.id,
    debtToken_id: debtToken.id,
    closingOnly: false,
  };

  context.Instrument.set(entity);
});


ContangoProxy.ClosingOnlySet.handler(async ({ event, context }) => {
  const { chainId, params } = event
  const instrument = await context.Instrument.get(createInstrumentId({ chainId, instrumentId: params.symbol }))
  if (!instrument) throw new Error('Instrument not found')

  context.Instrument.set({ ...instrument, closingOnly: event.params.closingOnly })
})