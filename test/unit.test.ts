import { expect } from 'chai'
import { TestHelpers } from 'generated'
import { describe, it } from 'mocha'
import { AccountingType } from '../src/accounting/lotsAccounting'
import { createIdForPosition } from '../src/utils/ids'
import { getTransactionHashes, processTransaction, processTransactions } from './testHelpers'
const { MockDb } = TestHelpers

describe('indexer tests', () => {
  let mockDb: ReturnType<typeof MockDb.createMockDb>
  beforeEach(async () => {
    mockDb = MockDb.createMockDb()
  })

  async function highLevelInvariants({ positionId, chainId }: { positionId: string; chainId: number }) {
    const position = mockDb.entities.Position.get(createIdForPosition({ chainId, positionId }))
    if (!position) throw new Error('Position not found in test!')
    const fillItems = mockDb.entities.FillItem.getAll()
    const lots = mockDb.entities.Lot.getAll()
    const instrument = mockDb.entities.Instrument.get(position.instrument_id)
    if (!instrument) throw new Error('Instrument not found in test!')
    const debtToken = mockDb.entities.Token.get(instrument.debtToken_id)
    if (!debtToken) throw new Error('Debt token not found in test!')
    const collateralToken = mockDb.entities.Token.get(instrument.collateralToken_id)
    if (!collateralToken) throw new Error('Collateral token not found in test!')

    const aggregatedQuoteCashflow = fillItems.reduce((acc, fillItem) => acc + fillItem.cashflowQuote, 0n)
    const aggregatedBaseCashflow = fillItems.reduce((acc, fillItem) => acc + fillItem.cashflowBase, 0n)

    expect(position.cashflowQuote).to.equal(aggregatedQuoteCashflow)
    expect(position.cashflowBase).to.equal(aggregatedBaseCashflow)
    expect(lots.length).to.equal(0)

    expect((Number(position.realisedPnl_long) / Number(debtToken.unit)).toFixed(3)).to.equal((Number(position.cashflowQuote) / Number(debtToken.unit) * -1).toFixed(3))
    expect((Number(position.realisedPnl_short) / Number(collateralToken.unit)).toFixed(3)).to.equal((Number(position.cashflowBase) / Number(collateralToken.unit) * -1).toFixed(3))
  }

  it('RDNT/ETH short - Chain: Arbitrum - Number: #20498', async function() {
    this.timeout(30000)
    const positionId = '0x5745544852444e54000000000000000010ffffffff0000000000000000005012'
    const transactionHashes = await getTransactionHashes(42161, positionId)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(42161, transactionHashes[i], mockDb)

      const position = mockDb.entities.Position.get(createIdForPosition({ chainId: 42161, positionId }))
      if (!position) throw new Error('Position not found in test!')
      const fillItems = mockDb.entities.FillItem.getAll()
      const swapEvents = mockDb.entities.ContangoSwapEvent.getAll()
      const lots = mockDb.entities.Lot.getAll()
      const fillItem = fillItems[i]

      if (i === 0) {
        const longLot = lots.filter(lot => lot.accountingType === AccountingType.Long)[i]
        const shortLot = lots.filter(lot => lot.accountingType === AccountingType.Short)[i]

        expect(fillItem.collateralDelta).to.equal(39990067205165300n) // 0.03999006721
        expect(fillItem.debtDelta).to.equal(857574179879525749083n) // 857.5741798795

        expect(fillItem.cashflow).to.equal(BigInt(0.02e18))
        expect(fillItem.cashflowQuote).to.equal(858000296925399332723n) // 858.0002969253993
        expect(fillItem.cashflowBase).to.equal(BigInt(0.02e18)) // 0.02

        expect(longLot.openCost).to.equal(-1n * (fillItem.cashflowQuote + fillItem.debtDelta)) // -1666.09835550565
        expect(shortLot.openCost).to.equal(fillItem.collateralDelta - fillItem.cashflowBase) // 0.03999006721 - 0.02 --> 0.01999006721

        expect(fillItem.fillCost_long).to.equal(-(857574179879525749083n + 858000296925399332723n)) // casfhlowQuote + debtDelta (negated)
        expect(fillItem.fillCost_short).to.equal(fillItem.collateralDelta - fillItem.cashflowBase)

        expect(fillItem.swapPrice_long).to.equal(42900014846269966636158n) // 42900.014846269966636158
        expect(fillItem.swapPrice_short).to.equal(23310015243198n) // 0.00002331001524
        // 0.00002331001524 * 42900.014846269966636158 = 1 (perfect inverse of each other)

        expect(fillItem.fillPrice_long).to.equal(42900014846269966636129n) // same as swap price long (tiny precision loss)
        expect(fillItem.fillPrice_short).to.equal(23310015243198n) // same as swap price short (no precision loss)

      } else if (i === 1) {
        expect(fillItem.collateralDelta).to.equal(-40062624496224149n) // 0.0400626245 --> original 0.03999006721 + 0.00007255729 (lending profit)
        expect(fillItem.debtDelta).to.equal(-907050301178798335096n) // 907.0503011788 --> original 857.5741798795 + 49.4761212993 (debt cost)

        expect(fillItem.cashflowQuote).to.equal(-1111911232291604141718n) // -1111.911232291604141718
        expect(fillItem.cashflowBase).to.equal(-22125086346822562n) // -0.02212508635
        expect(fillItem.cashflow).to.equal(-22013913848738841n) // -0.02201391385

        expect(fillItem.fillCost_long).to.equal(2018961533470402476814n) // 2018.9613011788 --> 1111.911 + 907.0503011788
        expect(fillItem.fillPrice_long).to.equal(50395139081831421531339n) // 50395.139081831421531339
        expect(fillItem.swapPrice_long).to.equal(50255678773940172326698n) // 50255.6787739402 (seems like this trade got lucky with some dust in the contract that was sent to it)


        expect(fillItem.realisedPnl_short).to.equal(22125086346822562n - BigInt(0.02e18)) // 0.002013913849
        expect(fillItem.realisedPnl_long).to.equal(1111911232291604141718n - 858000296925399332723n)
      }
    }

    await highLevelInvariants({ positionId, chainId: 42161 })

  })

  it('ARB/DAI long - Chain: Arbitrum - Number: #21272', async function() {
    this.timeout(30000)
    const positionId = '0x4152424441490000000000000000000001ffffffff0200000000000000005318'
    mockDb = await processTransactions(42161, positionId, mockDb)

    await highLevelInvariants({ positionId, chainId: 42161 })
  })

  it('ETH/USDC.e long - Chain: Arbitrum - Number: #21105 - MIGRATION', async function() {
    this.timeout(30000)
    const positionId = '0x5745544855534443000000000000000001ffffffff0000000000000000005271'
    const transactionHashes = await getTransactionHashes(42161, positionId)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(42161, transactionHashes[i], mockDb)
      const lots = mockDb.entities.Lot.getAll()
      let fillItems = mockDb.entities.FillItem.getAll()
      let position = mockDb.entities.Position.get(createIdForPosition({ chainId: 42161, positionId }))

      if (!position) {
        const migratedToPositionId = '0x5745544855534443000000000000000011ffffffff00000000000000000053e2'
        position = mockDb.entities.Position.get(createIdForPosition({ chainId: 42161, positionId: migratedToPositionId }))
        if (!position) throw new Error('Position not found in test!')
        fillItems = [fillItems[i], fillItems[i + 1]]
      }
    }
  })

  it('ARB/USDC long - Chain: Arbitrum - Number: #5488 - REALISED PNL IS FUCKED', async function() {
    this.timeout(30000)
    const positionId = '0x415242555344432e6e0000000000000001ffffffff0200000000000000001570'
    const transactionHashes = await getTransactionHashes(42161, positionId)

    for (let i = 0; i < transactionHashes.length; i++) {
      mockDb = await processTransaction(42161, transactionHashes[i], mockDb)

      const position = mockDb.entities.Position.get(createIdForPosition({ chainId: 42161, positionId }))
      if (!position) throw new Error('Position not found in test!')
      const fillItems = mockDb.entities.FillItem.getAll()
      const fillItem = fillItems[i]
      // const swapEvents = mockDb.entities.ContangoSwapEvent.getAll()
      // const lots = mockDb.entities.Lot.getAll()

      if (i === 0) {
        expect(fillItem.cashflow).to.equal(BigInt(0.02e18))
        expect(fillItem.cashflowQuote).to.equal(BigInt(68.027973e6))
        expect(fillItem.cashflowBase).to.equal(80735499391093514082n) // 80.735
        expect(fillItem.swapPrice_long).to.equal(BigInt(0.842603e6))
        expect(fillItem.swapPrice_short).to.equal(1186798527895105998n) // 1 / 0.842603 = 1.186865 (the inverse of the long trade price)
      } else if (i === 1) {
        expect(fillItem.cashflow).to.equal(-19930869917414180n) // 0.01993086991741418
        expect(fillItem.cashflowBase).to.equal(-80867067518738762881n) // 80.867
        expect(fillItem.cashflowQuote).to.equal(-68250187n) // 68.250187

        expect(fillItem.realisedPnl_short).to.equal(80867067518738762881n - 80735499391093514082n) // sum of base cashflows

        expect(fillItem.swapPrice_long).to.equal(BigInt(0.843980e6))
        expect(fillItem.fillPrice_long).to.equal(BigInt(0.843980e6))

        expect(fillItem.swapPrice_short).to.equal(1184861656014328796n) // 1 / 0.842603 = 1.18486 (the inverse of the long trade price)
        expect(fillItem.fillPrice_short).to.equal(1184861653848222336n) // 1 / 0.842603 = 1.18486 (the inverse of the long trade price)

        expect(fillItem.realisedPnl_long).to.equal(222282n) // sum of quote cashflows
        expect(fillItem.realisedPnl_short).to.equal(80867067518738762881n - 80735499391093514082n) // sum of base cashflows
      }
    }

    await highLevelInvariants({ positionId, chainId: 42161 })
  })


})
