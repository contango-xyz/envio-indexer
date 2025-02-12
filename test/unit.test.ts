import { expect } from 'chai'
import { Lot, TestHelpers } from 'generated'
import { describe, it } from 'mocha'
import { createIdForPosition } from '../src/utils/ids'
import { FillItemType } from '../src/utils/types'
import { getTransactionHashes, processTransaction } from './testHelpers'
import { getBalancesAtBlock } from '../src/utils/common'
import { mulDiv } from '../src/utils/math-helpers'
import { AccountingType } from '../src/accounting/lots'

const { MockDb } = TestHelpers

const calculateEntryPrice = (lot: Lot) => {
  return Number(lot.grossOpenCost) / Number(lot.grossSize)
}

describe('indexer tests', () => {
  let mockDb: ReturnType<typeof MockDb.createMockDb>

  beforeEach(() => {
    mockDb = MockDb.createMockDb()
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

      if (i === 0) {
        console.log(`Position state after trade number ${i + 1}`, position)
        console.log('fillItem', fillItems[i])

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

        console.log('shortLots after trade 2', shortLots)

        console.log('------------- TWO FINISHED -------------------')
        
      } else if (i === 2) {
        console.log(`Position state after trade number ${i + 1}`, position)
        console.log('fillItem', fillItems[i])

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

        // pnl long:  46130387217010
        // pnl short:
        // collateral delta: -12963310727632896
        // collateral delta in quote ccy: -12963310727632896 * 1.033029241515446081 = -13187613148871857
        // realised pnl short: -13187613148871857 - (-13386791261471010 + 0) = 199178112599153 (0.0001991781126)

        // alternative calculation:
        // 

        // -9375574049290972n
        // -9369487592649461

        expect(position?.realisedPnl_short, 'position?.realisedPnl_short').to.equal(-199178112599153n)
        expect(fillItems[i].realisedPnl_short, 'fillItems[i].realisedPnl_short').to.equal(-5538989447041113n)
        expect(fillItems[i].collateralDelta, 'fillItems[i].collateralDelta').to.equal(-12963310727632896n)
        expect(fillItems[i].fillItemType, 'fillItems[i].fillItemType').to.equal(FillItemType.Trade)
        expect(fillItems[i].cashflowSwap_id).to.be.undefined

        expect(position?.collateral).to.equal(19753141049332163n)
        expect(position?.debt).to.equal(9903142301618520n) // 9999999999999999 + 13289933563089531 + -13386791261471010 = 9903142301618520
        // expect(position?.accruedInterest).to.equal(0n)
        // expect(position?.accruedLendingProfit).to.equal(0n)
        // expect(position?.realisedPnl_long).to.equal(46130387217010n)
        // expect(position?.realisedPnl_short).to.equal(-346105178850924n)

        console.log('------------- THREE FINISHED -------------------')
        
      } else if (i === 3) {
        const fillItem = fillItems[i]

        console.log(`Position state after trade number ${i + 1}`, position)
        console.log('fillItem', fillItems[i])

        const totalCollateral = 19753141049332163n
        const totalDebt = 9903142301618520n
        const totalCashflowQuote = 0n
        
        
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