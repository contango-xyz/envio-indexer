import { expect } from 'chai'
import { Lot, Position, TestHelpers } from 'generated'
import { describe, it } from 'mocha'
import { hexToBigInt } from 'viem'
import { partialFillItemWithCashflowEventsToFillItem, updateFillItemWithCashflowEvents } from '../src/accounting/helpers'
import { AccountingType } from '../src/accounting/lotsAccounting'
import { eventsToFillItem, processEvents } from '../src/accounting/processEvents'
import { eventStore } from '../src/Store'
import { getBalancesAtBlock } from '../src/utils/common'
import { createEventId, createIdForPosition } from '../src/utils/ids'
import { mulDiv } from '../src/utils/math-helpers'
import { ContangoEvents, FillItemType } from '../src/utils/types'
import { collateralToken, createCollateralEvent, createDebtEvent, createFeeCollectedEvent, createSwapEvent, createTransferEvent, debtToken, emptyPartialFillItem, maestroProxy, TRADER, WETH_ADDRESS, wrsETH_ADDRESS } from './createEvents'
import { getTransactionHashes, processTransaction } from './testHelpers'
const { MockDb, Maestro, PositionNFT, UnderlyingPositionFactory, ContangoProxy } = TestHelpers

const calculateEntryPrice = (lot: Lot) => {
  return Number(lot.grossOpenCost) / Number(lot.grossSize)
}

describe('indexer tests', () => {
  let mockDb: ReturnType<typeof MockDb.createMockDb>
  const blockNumber = 18958249300517
  const proxyAddress = '0x0000000000000000000000000000000000000003'
  const positionId = '0x7772734554485745544800000000000012ffffffff0000000000000000000001'
  let position: Position

  beforeEach(async () => {
    mockDb = MockDb.createMockDb()


    mockDb = await PositionNFT.Transfer.processEvent({
      event: {
        params: {
          tokenId: hexToBigInt(positionId),
          from: '0x0000000000000000000000000000000000000000',
          to: TRADER,
        },
        chainId: 1,
        srcAddress: '0x0000000000000000000000000000000000000000',
        logIndex: 0,
        transaction: {
          hash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
          from: TRADER,
          to: maestroProxy,
        },
        block: {
          number: blockNumber,
          timestamp: 18958249300517,
          hash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
        }
      },
      mockDb,
    })

    const createUnderlyingMockEvent = UnderlyingPositionFactory.UnderlyingPositionCreated.createMockEvent({
      account: proxyAddress,
      positionId,
    })

    mockDb = await UnderlyingPositionFactory.UnderlyingPositionCreated.processEvent({
      event: createUnderlyingMockEvent,
      mockDb,
    })

    const pos = mockDb.entities.Position.get(createIdForPosition({ chainId: 1, positionId }))
    if (pos) {
      position = pos
    } else {
      throw new Error('Position not found in test!')
    }
  })

  it('fully mocked test - OPEN basic', async () => {

    const events = [
      createDebtEvent({ debtDelta: BigInt(0.1e18) }),
      createSwapEvent({ amountIn: BigInt(0.2e18), amountOut: BigInt(0.18e18), tokenIn: WETH_ADDRESS, tokenOut: wrsETH_ADDRESS }),
      createCollateralEvent({ collateralDelta: BigInt(0.2e18) }),
    ]

    const transferEvent = createTransferEvent({ amount: BigInt(0.1e18), token: debtToken })

    expect(position?.owner).to.equal(TRADER)
    expect(position?.isOpen).to.be.true
    expect(position?.proxyAddress).to.equal(proxyAddress)

    const result = events.reduce((acc, curr) => eventsToFillItem(position, debtToken, collateralToken, curr, acc), emptyPartialFillItem)

    expect(result.debtDelta).to.equal(BigInt(0.1e18))
    expect(result.collateralDelta).to.equal(BigInt(0.2e18))
    expect(result.tradePrice_long).to.equal(1111111111111111111n)
    expect(result.tradePrice_short).to.equal(BigInt(0.9e18))
    expect(result.debtCostToSettle).to.equal(0n)
    expect(result.lendingProfitToSettle).to.equal(0n)
    expect(result.fee).to.equal(0n)
    expect(result.feeToken_id).to.be.undefined
    expect(result.liquidationPenalty).to.equal(0n)

    const fillItem = {
      ...result,
      cashflowQuote: 0n,
      cashflowBase: 0n,
      cashflow: 0n,
      cashflowToken_id: collateralToken.id,
    }

    const fillItemWithCashflows = updateFillItemWithCashflowEvents({ event: transferEvent, fillItem, owner: TRADER })

    expect(fillItemWithCashflows.cashflowQuote).to.equal(BigInt(0.1e18))
    expect(fillItemWithCashflows.cashflowBase).to.equal(0n)
    // expect(fillItemWithCashflows.cashflow).to.equal(BigInt(0.1e18))
    expect(fillItemWithCashflows.cashflowToken_id).to.equal(debtToken.id)

    const partialFillItemWithRelativeCashflows = partialFillItemWithCashflowEventsToFillItem(fillItemWithCashflows, position, { ...events[0], logIndex: 0 })

    console.log('fillItemWithCashflows', fillItemWithCashflows)
    console.log('partialFillItemWithRelativeCashflows', partialFillItemWithRelativeCashflows)

    expect(partialFillItemWithRelativeCashflows.cashflowQuote).to.equal(BigInt(0.1e18))
    expect(partialFillItemWithRelativeCashflows.cashflowBase).to.equal(BigInt(0.09e18)) // 0.1 * (0.18 / 0.2) = 0.09
    expect(partialFillItemWithRelativeCashflows.cashflowToken_id).to.equal(debtToken.id)
    
    const allEvents: ContangoEvents[] = [...events, transferEvent]

    for (const event of allEvents) {
      eventStore.addLog({
        eventId: createEventId({
          eventType: event.eventType,
          chainId: event.chainId,
          blockNumber,
          transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
          logIndex: 0,
        }),
        contangoEvent: event,
      })
    }

    const finalResult = await processEvents({
      genericEvent: { ...events[0], positionId, logIndex: 0 },
      events: allEvents,
      position,
      lots: { longLots: [], shortLots: [] },
      debtToken,
      collateralToken,
    })
    
    expect(finalResult.position?.accruedInterest).to.equal(0n)
    expect(finalResult.position?.accruedLendingProfit).to.equal(0n)
    expect(finalResult.position?.realisedPnl_long).to.equal(0n)
    expect(finalResult.position?.realisedPnl_short).to.equal(0n)
    expect(finalResult.position?.cashflowBase).to.equal(BigInt(0.09e18))
    expect(finalResult.position?.cashflowQuote).to.equal(BigInt(0.1e18))    
  })

  it.only('fully mocked test - CLOSE basic', async () => {

    const events = [
      createDebtEvent({ debtDelta: BigInt(0.1e18) }),
      createSwapEvent({ amountIn: BigInt(0.2e18), amountOut: BigInt(0.18e18), tokenIn: WETH_ADDRESS, tokenOut: wrsETH_ADDRESS }),
      createCollateralEvent({ collateralDelta: BigInt(0.2e18) }),
    ]

    const transferEvent = createTransferEvent({ amount: BigInt(0.1e18), token: debtToken })
    
    const allEvents: ContangoEvents[] = [...events, transferEvent]

    for (const event of allEvents) {
      eventStore.addLog({
        eventId: createEventId({
          eventType: event.eventType,
          chainId: event.chainId,
          blockNumber,
          transactionHash: '0x7772734554485745544800000000000012ffffffff0000000000000000000002',
          logIndex: 0,
        }),
        contangoEvent: event,
      })
    }

    const { position: position1, lots: lots1, fillItem: fillItem1 } = await processEvents({
      genericEvent: { ...events[0], positionId, logIndex: 0 },
      events: [
        createDebtEvent({ debtDelta: BigInt(0.1e18) }),
        createSwapEvent({ amountIn: BigInt(0.2e18), amountOut: BigInt(0.18e18), tokenIn: WETH_ADDRESS, tokenOut: wrsETH_ADDRESS }),
        createCollateralEvent({ collateralDelta: BigInt(0.2e18) }),
        createTransferEvent({ amount: BigInt(0.1e18), token: debtToken }),
      ],
      position,
      lots: { longLots: [], shortLots: [] },
      debtToken,
      collateralToken,
    })

    expect(position1?.collateral).to.equal(BigInt(0.2e18))
    expect(position1?.debt).to.equal(BigInt(0.1e18))

    const events2 = [
      createDebtEvent({ debtDelta: -BigInt(0.05e18) }),
      createSwapEvent({ amountIn: BigInt(0.9e18), amountOut: BigInt(0.95e18), tokenIn: wrsETH_ADDRESS, tokenOut: WETH_ADDRESS }),
      createCollateralEvent({ collateralDelta: -BigInt(0.1e18) }),
    ]

    const { position: position2, lots: lots2, fillItem: fillItem2 } = await processEvents({
      genericEvent: { ...events2[0], positionId, logIndex: 0 },
      events: events2,
      position: position1,
      lots: lots1,
      debtToken,
      collateralToken,
    })

  })

  it('Linea -> open, increase, decrease, close', async function() {
    this.timeout(30000)
    const positionId = '0x7772734554485745544800000000000012ffffffff0000000000000000000002'
    const transactionHashes = await getTransactionHashes(59144, positionId)

    let longLotsBefore: Lot[] = []
    let shortLotsBefore: Lot[] = []

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(59144, transactionHashes[i], mockDb)
      const position = mockDb.entities.Position.get(createIdForPosition({ chainId: 59144, positionId }))
      if (!position) throw new Error('Position not found in test!')
      const fillItems = mockDb.entities.FillItem.getAll()
      const debtEvents = mockDb.entities.ContangoDebtEvent.getAll()
      const swapEvents = mockDb.entities.ContangoSwapEvent.getAll()
      const lots = mockDb.entities.Lot.getAll()
      const longLots = lots.filter(lot => lot.accountingType === AccountingType.Long)
      const shortLots = lots.filter(lot => lot.accountingType === AccountingType.Short)

      // Assert that the sum of the debt and collateral deltas on the fill items is equal to the position's debt and collateral
      const totalDebtDeltasOnFillItems = fillItems.reduce((acc, fillItem) => acc + fillItem.debtDelta, 0n)
      const totalCollateralDeltasOnFillItems = fillItems.reduce((acc, fillItem) => acc + fillItem.collateralDelta, 0n)
      expect(totalDebtDeltasOnFillItems, `totalDebtDeltasOnFillItems trade ${i + 1}`).to.equal(position?.debt)
      expect(totalCollateralDeltasOnFillItems, `totalCollateralDeltasOnFillItems trade ${i + 1}`).to.equal(position?.collateral)

      // Assert that the sum of the lending profit and debt cost on the fill items is equal to the position's accrued lending profit and accrued interest
      const totalLendingProfitOnFillItems = fillItems.reduce((acc, fillItem) => acc + fillItem.lendingProfitToSettle, 0n)
      const totalDebtCostOnFillItems = fillItems.reduce((acc, fillItem) => acc + fillItem.debtCostToSettle, 0n)
      expect(totalLendingProfitOnFillItems, `totalLendingProfitOnFillItems trade ${i + 1}`).to.equal(position?.accruedLendingProfit)
      expect(totalDebtCostOnFillItems, `totalDebtCostOnFillItems trade ${i + 1}`).to.equal(position?.accruedInterest)

      console.log(`Position state after trade number ${i + 1}`, position)

      if (i === 0) {

        expect(fillItems[i].collateralDelta, 'fillItems[i].collateralDelta').to.equal(19655463075342034n)
        expect(fillItems[i].debtDelta, 'fillItems[i].debtDelta').to.equal(9999999999999999n)
        expect(fillItems[i].realisedPnl_long, 'fillItems[i].realisedPnl_long').to.equal(0n)
        expect(fillItems[i].realisedPnl_short, 'fillItems[i].realisedPnl_short').to.equal(0n)
        expect(fillItems[i].fillItemType, 'fillItems[i].fillItemType').to.equal(FillItemType.Trade)
        expect(fillItems[i].cashflowQuote, 'fillItems[i].cashflowQuote').to.equal(10000000000000000n)
        expect(fillItems[i].cashflowSwap_id).to.be.undefined
        expect(longLots.length).to.equal(1)
        
        expect(position).to.exist
        expect(position?.collateral).to.equal(19655463075342034n)
        expect(position?.debt).to.equal(9999999999999999n)
        expect(position?.accruedInterest).to.equal(0n)
        expect(position?.accruedLendingProfit).to.equal(0n)
        expect(position?.realisedPnl_long).to.equal(0n)
        expect(position?.realisedPnl_short).to.equal(0n)
        expect(position?.cashflowBase).to.equal(9827731537671017n)
        expect(position?.cashflowQuote).to.equal(10000000000000000n)
        // 0.01 / 0.009827731537671017 = 1.017528812388561369
        expect(fillItems[i].tradePrice_long).to.equal(1017528812388561369n)
        expect(position?.isOpen).to.be.true

        expect(longLots.length).to.equal(1)
        expect(shortLots.length).to.equal(1)

        // long lot size
        expect(longLots[0].size).to.equal(19655463075342034n)
        expect(longLots[0].grossSize).to.equal(19655463075342034n)
        expect(longLots[0].openCost).to.equal(19999999999999999n)
        expect(longLots[0].grossOpenCost).to.equal(19999999999999999n)
        expect(longLots[0].closedAtBlock).to.be.undefined
        expect(longLots[0].nextLotId).to.be.undefined

        expect(shortLots[0].size).to.equal(9999999999999999n)
        expect(shortLots[0].grossSize).to.equal(9999999999999999n)
        expect(shortLots[0].openCost).to.equal(19655463075342034n)
        expect(shortLots[0].grossOpenCost).to.equal(19655463075342034n)
        expect(shortLots[0].closedAtBlock).to.be.undefined
        expect(shortLots[0].nextLotId).to.be.undefined
        
        // The lots are the inverses of each other

        console.log('------------- ONE FINISHED -------------------')

      } else if (i === 1) {
        const fillItem = fillItems[i]

        expect(fillItem.collateralDelta, 'fillItem.collateralDelta').to.equal(13060988701623025n)
        expect(fillItem.debtDelta, 'fillItem.debtDelta').to.equal(13289933563089531n)
        expect(fillItem.realisedPnl_long, 'fillItem.realisedPnl_long').to.equal(0n)
        expect(fillItem.realisedPnl_short, 'fillItem.realisedPnl_short').to.equal(0n)
        expect(fillItem.fillItemType, 'fillItem.fillItemType').to.equal(FillItemType.Trade)
        expect(fillItem.cashflowQuote, 'fillItem.cashflowQuote').to.equal(0n)
        expect(fillItem.cashflowBase, 'fillItem.cashflowBase').to.equal(0n)
        expect(fillItem.cashflowSwap_id).to.be.undefined

        expect(position).to.exist
        expect(position?.collateral).to.equal(19655463075342034n + 13060988701623025n)
        expect(position?.debt).to.equal(9999999999999999n + 13289933563089531n)
        expect(position?.accruedInterest).to.equal(0n)
        expect(position?.accruedLendingProfit).to.equal(0n)
        expect(position?.realisedPnl_long).to.equal(0n)
        expect(position?.realisedPnl_short).to.equal(0n)
        expect(position?.cashflowQuote).to.equal(10000000000000000n)
        expect(position?.isOpen).to.be.true

        expect(longLots.length).to.equal(2)
        expect(shortLots.length).to.equal(2)

        // LONG LOTS
        expect(longLots[0].size).to.equal(19655463075342034n)
        expect(longLots[0].grossSize).to.equal(19655463075342034n)
        expect(longLots[0].openCost).to.equal(19999999999999999n)
        expect(longLots[0].grossOpenCost).to.equal(19999999999999999n)
        expect(longLots[0].nextLotId).to.equal(longLots[1].id)
        expect(longLots[0].closedAtBlock).to.be.undefined

        expect(longLots[1].size).to.equal(13060988701623025n)
        expect(longLots[1].grossSize).to.equal(13060988701623025n)
        expect(longLots[1].openCost).to.equal(13289933563089531n)
        expect(longLots[1].grossOpenCost).to.equal(13289933563089531n)
        expect(longLots[1].nextLotId).to.be.undefined
        expect(longLots[1].closedAtBlock).to.be.undefined
        
        // SHORT LOTS
        expect(shortLots[0].size).to.equal(9999999999999999n)
        expect(shortLots[0].grossSize).to.equal(9999999999999999n)
        expect(shortLots[0].openCost).to.equal(19655463075342034n)
        expect(shortLots[0].grossOpenCost).to.equal(19655463075342034n)
        expect(shortLots[0].nextLotId).to.equal(shortLots[1].id)
        expect(shortLots[0].closedAtBlock).to.be.undefined     

        expect(shortLots[1].size).to.equal(fillItem.debtDelta)
        expect(shortLots[1].grossSize).to.equal(fillItem.debtDelta)
        expect(shortLots[1].openCost).to.equal(fillItem.collateralDelta)
        expect(shortLots[1].grossOpenCost).to.equal(fillItem.collateralDelta)
        expect(shortLots[1].nextLotId).to.be.undefined
        expect(shortLots[1].closedAtBlock).to.be.undefined

        console.log('------------- TWO FINISHED -------------------')
        
      } else if (i === 2) {

        const lotZeroEntryPriceBefore = calculateEntryPrice(longLotsBefore[0])

        const fillItem = fillItems[i]

        const totalCollateral = 19655463075342034n + 13060988701623025n
        const totalDebt = 9999999999999999n + 13289933563089531n
        const totalCashflowQuote = 10000000000000000n + 0n

        const snapshotRightBeforeTrade3 = await getBalancesAtBlock(59144, positionId, fillItem.blockNumber - 1)
        expect(snapshotRightBeforeTrade3.collateral, 'snapshotRightBeforeTrade3.collateral').to.equal(32723718228574525n)
        expect(snapshotRightBeforeTrade3.debt, 'snapshotRightBeforeTrade3.debt').to.equal(23676277020657545n)

        const debtCostToSettle = snapshotRightBeforeTrade3.debt - totalDebt
        // they're not exactly equal, but that's because the `getBalancesAtBlock` returns the balance 1 block before the trade.
        expect(debtCostToSettle, 'debtCostToSettle').to.equal(386343457568015n)
        expect(fillItem.debtCostToSettle, 'fillItem.debtCostToSettle').to.equal(386343499194121n)

        const lendingProfitToSettle = snapshotRightBeforeTrade3.collateral - totalCollateral
        expect(lendingProfitToSettle, 'lendingProfitToSettle').to.equal(7266451609466n)
        expect(fillItem.lendingProfitToSettle, 'fillItem.lendingProfitToSettle').to.equal(7266451852081n)

        // open cost and deltas
        const openCost = totalDebt + totalCashflowQuote
        const costDelta = mulDiv(openCost + fillItem.debtCostToSettle, fillItem.collateralDelta, totalCollateral + fillItem.lendingProfitToSettle)

        expect(costDelta, 'costDelta').to.equal(-13340661371536917n)

        // LONG LOTS

        const shareOfLendingProfitLot0 = mulDiv(lendingProfitToSettle, longLotsBefore[0].size, longLotsBefore[0].size + longLotsBefore[1].size)
        expect(Number(shareOfLendingProfitLot0)).to.be.lessThan(Number(fillItem.lendingProfitToSettle))
        expect(shareOfLendingProfitLot0).to.equal(4365555050782n)
        // lot zero share of lending profit: 7266451609466 * 19655463075342034 / (19655463075342034 + 13060988701623025) => 436555505078270621
        //  19655463075342034n + 4365555050782n + (-12963310727632896n) // collateralDelta1 + share of lending profit + collateral delta of fill
        expect(longLots[0].size).to.equal(6696517902905679n)
        expect(lotZeroEntryPriceBefore).to.be.closeTo(calculateEntryPrice(longLots[0]), 1e-14)
        
        expect(fillItems[i].debtDelta, 'fillItems[i].debtDelta').to.equal(-13386791261471010n)
        expect(fillItems[i].cashflowQuote, 'fillItems[i].cashflowQuote').to.equal(0n)
        expect(fillItems[i].cashflowBase, 'fillItems[i].cashflowBase').to.equal(0n)

        // expected realised pnl long: costDelta - (fillItem.debtDelta + fillItem.cashflowQuote)
        // (-13340661371536917n + 0n) - (-13386791261471010n + 0n) = 46129889934093
        expect(position?.realisedPnl_long, 'position?.realisedPnl_long').to.equal(46130387217010n)
        expect(fillItems[i].realisedPnl_long, 'fillItems[i].realisedPnl_long').to.equal(46130387217010n) // 0.00004613038722

        const costDeltaShort = mulDiv(totalCollateral + lendingProfitToSettle, fillItem.debtDelta, totalDebt + fillItem.debtCostToSettle)
        expect(costDeltaShort, 'costDeltaShort').to.equal(-18502300174674009n)
        expect(fillItems[i].collateralDelta, 'fillItems[i].collateralDelta').to.equal(-12963310727632896n)

        // cashflowBase:
        // 9810977519803654 - 9827731537671017 = -16754017867363 (-0.00001675401787)

        expect(position?.realisedPnl_short, 'position?.realisedPnl_short').to.equal(-16754017867363n)
        expect(fillItems[i].realisedPnl_short, 'fillItems[i].realisedPnl_short').to.equal(-16754017867363n)
        expect(fillItems[i].collateralDelta, 'fillItems[i].collateralDelta').to.equal(-12963310727632896n)
        expect(fillItems[i].fillItemType, 'fillItems[i].fillItemType').to.equal(FillItemType.Trade)
        expect(fillItems[i].cashflowSwap_id).to.be.undefined

        expect(position?.collateral).to.equal(19753141049332163n)
        expect(position?.debt).to.equal(9903142301618520n) // 9999999999999999 + 13289933563089531 + -13386791261471010 = 9903142301618520

        console.log('------------- THREE FINISHED -------------------')
        
      } else if (i === 3) {
        const fillItem = fillItems[i]

        const totalCollateral = 19753141049332163n
        const totalDebt = 9903142301618520n
        const totalCashflowQuote = 0n
        
        expect(fillItem.realisedPnl_long, 'fillItem.realisedPnl_long').to.equal(148683342931661n) // 0.000148683342931661
      }

      longLotsBefore = longLots
      shortLotsBefore = shortLots
    }

    // Final state assertions
    const finalPosition = mockDb.entities.Position.get(createIdForPosition({ chainId: 59144, positionId }))

    expect(finalPosition).to.exist
    expect(finalPosition?.isOpen).to.be.false
  })
})
