import { FakeContract, MockContract, smock } from "@defi-wonderland/smock";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import BigNumber from "bignumber.js";
import chai from "chai";
import { constants } from "ethers";
import { parseUnits } from "ethers/lib/utils";
import { ethers } from "hardhat";
import sleep from "sleep-promise";

import { convertToUnit } from "../../helpers/utils";
import {
  AccessControlManager,
  Comptroller,
  Comptroller__factory,
  IRiskFund,
  MockToken,
  PriceOracle,
  Shortfall,
  Shortfall__factory,
  VToken,
  VToken__factory,
} from "../../typechain";

const { expect } = chai;
chai.use(smock.matchers);

let owner: SignerWithAddress;
let poolRegistry: SignerWithAddress;
let someone: SignerWithAddress;
let shortfall: MockContract<Shortfall>;
let fakeRiskFund: FakeContract<IRiskFund>;
let mockBUSD: MockToken;
let mockDAI: MockToken;
let mockWBTC: MockToken;
let vDAI: MockContract<VToken>;
let vWBTC: MockContract<VToken>;
let comptroller: MockContract<Comptroller>;
let fakeAccessControlManager: FakeContract<AccessControlManager>;
let fakePriceOracle: FakeContract<PriceOracle>;

let riskFundBalance = "10000";
const minimumPoolBadDebt = "10000";
let poolId;

async function mineNBlocks(n: number) {
  for (let index = 0; index < n; index++) {
    await ethers.provider.send("evm_mine", [Date.now() * 1000]);
    await sleep(100);
  }
}

/**
 * Deploying required contracts along with the poolRegistry.
 */
async function shortfallFixture() {
  const MockBUSD = await ethers.getContractFactory("MockToken");
  mockBUSD = await MockBUSD.deploy("BUSD", "BUSD", 18);
  await mockBUSD.faucet(convertToUnit(100000, 18));

  fakeRiskFund = await smock.fake<IRiskFund>("IRiskFund");

  const Shortfall = await smock.mock<Shortfall__factory>("Shortfall");
  shortfall = await Shortfall.deploy();
  await shortfall.initialize(mockBUSD.address, fakeRiskFund.address, parseUnits(minimumPoolBadDebt, "18"));

  [owner, poolRegistry, someone] = await ethers.getSigners();
  await shortfall.setPoolRegistry(poolRegistry.address);

  //Deploy Mock Tokens
  const MockDAI = await ethers.getContractFactory("MockToken");
  mockDAI = await MockDAI.deploy("MakerDAO", "DAI", 18);
  await mockDAI.faucet(convertToUnit(1000000, 18));

  const MockWBTC = await ethers.getContractFactory("MockToken");
  mockWBTC = await MockWBTC.deploy("Bitcoin", "BTC", 8);
  await mockWBTC.faucet(convertToUnit(1000000, 8));

  fakeAccessControlManager = await smock.fake<AccessControlManager>("AccessControlManager");
  fakeAccessControlManager.isAllowedToCall.returns(true);

  const Comptroller = await smock.mock<Comptroller__factory>("Comptroller");
  comptroller = await Comptroller.deploy(poolRegistry.address, fakeAccessControlManager.address);
  poolId = comptroller.address;

  const VToken = await smock.mock<VToken__factory>("VToken");
  vDAI = await VToken.deploy();
  vWBTC = await VToken.deploy();

  await vWBTC.setVariable("decimals", 8);
  vDAI.decimals.returns(18);

  vDAI.underlying.returns(mockDAI.address);
  await vWBTC.setVariable("underlying", mockWBTC.address);

  await vDAI.setVariable("shortfall", shortfall.address);
  await vWBTC.setVariable("shortfall", shortfall.address);

  comptroller.getAllMarkets.returns(() => {
    return [vDAI.address, vWBTC.address];
  });

  fakePriceOracle = await smock.fake<PriceOracle>("PriceOracle");

  const btcPrice = "21000.34";
  const daiPrice = "1";

  fakePriceOracle.getUnderlyingPrice.returns((args: any) => {
    if (vDAI && vWBTC) {
      if (args[0] === vDAI.address) {
        return convertToUnit(daiPrice, 18);
      } else {
        return convertToUnit(btcPrice, 28);
      }
    }

    return 1;
  });

  comptroller.oracle.returns(fakePriceOracle.address);

  fakeRiskFund.getPoolReserve.returns(parseUnits(riskFundBalance, 18));
  fakeRiskFund.transferReserveForAuction.returns(0);
}

describe("Shortfall: Tests", async function () {
  async function setup() {
    await loadFixture(shortfallFixture);
  }

  describe("setters", async function () {
    beforeEach(setup);

    describe("setPoolRegistry", async function () {
      it("reverts on invalid PoolRegistry address", async function () {
        await expect(shortfall.setPoolRegistry(constants.AddressZero)).to.be.rejectedWith("invalid address");
      });

      it("fails if called by a non-owner", async function () {
        await expect(shortfall.connect(someone).setPoolRegistry(poolRegistry.address)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("emits PoolRegistryUpdated event", async function () {
        const tx = shortfall.setPoolRegistry(someone.address);
        await expect(tx).to.emit(shortfall, "PoolRegistryUpdated").withArgs(poolRegistry.address, someone.address);
      });
    });

    describe("updateMinimumPoolBadDebt", async function () {
      it("fails if called by a non-owner", async function () {
        await expect(shortfall.connect(someone).updateMinimumPoolBadDebt(1)).to.be.rejectedWith(
          "Ownable: caller is not the owner",
        );
      });

      it("updates minimumPoolBadDebt in storage", async function () {
        await shortfall.updateMinimumPoolBadDebt(1);
        expect(await shortfall.minimumPoolBadDebt()).to.equal(1);
      });

      it("emits MinimumPoolBadDebtUpdated event", async function () {
        const tx = shortfall.updateMinimumPoolBadDebt(1);
        await expect(tx)
          .to.emit(shortfall, "MinimumPoolBadDebtUpdated")
          .withArgs(parseUnits(minimumPoolBadDebt, "18"), 1);
      });
    });
  });

  describe("Scenario 1", async function () {
    before(setup);

    it("Should have debt and reserve", async function () {
      vDAI.badDebt.returns(parseUnits("1000", 18));
      vWBTC.badDebt.returns(parseUnits("1", 8));

      expect(await fakeRiskFund.getPoolReserve(comptroller.address)).equal(parseUnits(riskFundBalance, 18).toString());

      expect(await vDAI.badDebt()).equal(parseUnits("1000", 18));
      expect(await vWBTC.badDebt()).equal(parseUnits("1", 8));
    });

    it("Should not be able to start auction", async function () {
      vDAI.badDebt.returns(parseUnits("20", 18));
      vWBTC.badDebt.returns(parseUnits("0.01", 8));

      await expect(shortfall.startAuction(poolId)).to.be.reverted;
    });

    it("Scenerio 1 - Start auction", async function () {
      vDAI.badDebt.returns(parseUnits("10000", 18));
      await vDAI.setVariable("badDebt", parseUnits("10000", 18));
      vWBTC.badDebt.returns(parseUnits("2", 8));
      await vWBTC.setVariable("badDebt", parseUnits("2", 8));

      await shortfall.startAuction(poolId);

      const auction = await shortfall.auctions(poolId);
      expect(auction.status).equal(1);
      expect(auction.auctionType).equal(0);
      expect(auction.seizedRiskFund).equal(parseUnits(riskFundBalance, 18));

      const startBidBps = new BigNumber(new BigNumber("10000").times(0.9).times(100)).dividedBy("52000.68").toFixed(2);
      expect(auction.startBidBps.toString()).equal(new BigNumber(startBidBps).times(100).toString());
    });

    it("Scenerio 1 - Place bid", async function () {
      const auction = await shortfall.auctions(poolId);

      await mockDAI.approve(shortfall.address, parseUnits("10000", 18));
      await mockWBTC.approve(shortfall.address, parseUnits("2", 8));

      const previousDaiBalance = await mockDAI.balanceOf(owner.address);
      const previousWBTCBalance = await mockWBTC.balanceOf(owner.address);

      await shortfall.placeBid(poolId, auction.startBidBps);
      expect((await mockDAI.balanceOf(owner.address)).div(parseUnits("1", 18)).toNumber()).lt(
        previousDaiBalance.div(parseUnits("1", 18)).toNumber(),
      );
      expect((await mockWBTC.balanceOf(owner.address)).div(parseUnits("1", 8)).toNumber()).lt(
        previousWBTCBalance.div(parseUnits("1", 8)).toNumber(),
      );

      let percentageToDeduct = new BigNumber(auction.startBidBps.toString()).dividedBy(100);
      let total = new BigNumber((await vDAI.badDebt()).toString()).dividedBy(parseUnits("1", "18").toString());
      let amountToDeduct = new BigNumber(total).times(percentageToDeduct).dividedBy(100).toString();
      let amountDeducted = new BigNumber(previousDaiBalance.div(parseUnits("1", 18)).toString())
        .minus((await mockDAI.balanceOf(owner.address)).div(parseUnits("1", 18)).toString())
        .toString();
      expect(amountDeducted).equal(amountToDeduct);

      percentageToDeduct = new BigNumber(auction.startBidBps.toString()).dividedBy(100);
      total = new BigNumber((await vWBTC.badDebt()).toString()).dividedBy(parseUnits("1", "8").toString());
      amountToDeduct = new BigNumber(total).times(percentageToDeduct).dividedBy(100).toString();
      amountDeducted = new BigNumber(previousWBTCBalance.toString())
        .minus((await mockWBTC.balanceOf(owner.address)).toString())
        .div(parseUnits("1", 8).toString())
        .toString();
      expect(amountDeducted).equal(amountToDeduct);
    });

    it("Scenario 1 - Close Auction", async function () {
      await mineNBlocks((await shortfall.nextBidderBlockLimit()).toNumber() + 2);

      //simulate transferReserveForAuction
      await mockBUSD.transfer(shortfall.address, parseUnits(riskFundBalance, 18));

      await shortfall.closeAuction(poolId);
      const auction = await shortfall.auctions(poolId);
      expect(auction.status).equal(2);

      expect(vWBTC.badDebtRecovered).to.have.been.calledOnce;
      expect(vWBTC.badDebtRecovered).to.have.been.calledWith(parseUnits("2", 8));

      expect(vDAI.badDebtRecovered).to.have.been.calledOnce;
      expect(vDAI.badDebtRecovered).to.have.been.calledWith(parseUnits("10000", 18));
    });
  });

  describe("Scenario 2", async function () {
    before(setup);

    it("Scenerio 2 - Start auction", async function () {
      vDAI.badDebt.returns(parseUnits("10000", 18));
      await vDAI.setVariable("badDebt", parseUnits("10000", 18));
      vWBTC.badDebt.returns(parseUnits("1", 8));
      await vWBTC.setVariable("badDebt", parseUnits("1", 8));

      riskFundBalance = "50000";
      fakeRiskFund.getPoolReserve.returns(parseUnits(riskFundBalance, 18));

      await shortfall.startAuction(poolId);

      const auction = await shortfall.auctions(poolId);
      expect(auction.status).equal(1);
      expect(auction.auctionType).equal(1);

      const startBidBps = new BigNumber(new BigNumber("21000.34").plus(10000).times(1.1).times(100)).dividedBy(
        riskFundBalance,
      );
      expect(new BigNumber(startBidBps).times(riskFundBalance).dividedBy(100).toString()).equal(
        new BigNumber(auction.seizedRiskFund.toString()).dividedBy(parseUnits("1", 18).toString()).toString(),
      );
    });

    it("Scenerio 2 - Place bid", async function () {
      const auction = await shortfall.auctions(poolId);

      await mockDAI.approve(shortfall.address, parseUnits("10000", 18));
      await mockWBTC.approve(shortfall.address, parseUnits("1", 8));

      const previousDaiBalance = await mockDAI.balanceOf(owner.address);
      const previousWBTCBalance = await mockWBTC.balanceOf(owner.address);

      await shortfall.placeBid(poolId, auction.startBidBps);
      expect((await mockDAI.balanceOf(owner.address)).div(parseUnits("1", 18)).toNumber()).lt(
        previousDaiBalance.div(parseUnits("1", 18)).toNumber(),
      );
      expect((await mockWBTC.balanceOf(owner.address)).div(parseUnits("1", 8)).toNumber()).lt(
        previousWBTCBalance.div(parseUnits("1", 8)).toNumber(),
      );

      let percentageToDeduct = new BigNumber(auction.startBidBps.toString()).dividedBy(100);
      let total = new BigNumber((await vDAI.badDebt()).toString()).dividedBy(parseUnits("1", "18").toString());
      let amountToDeduct = new BigNumber(total).times(percentageToDeduct).dividedBy(100).toString();
      let amountDeducted = new BigNumber(previousDaiBalance.div(parseUnits("1", 18)).toString())
        .minus((await mockDAI.balanceOf(owner.address)).div(parseUnits("1", 18)).toString())
        .toString();
      expect(amountDeducted).equal(amountToDeduct);

      percentageToDeduct = new BigNumber(auction.startBidBps.toString()).dividedBy(100);
      total = new BigNumber((await vWBTC.badDebt()).toString()).dividedBy(parseUnits("1", "8").toString());
      amountToDeduct = new BigNumber(total).times(percentageToDeduct).dividedBy(100).toString();
      amountDeducted = new BigNumber(previousWBTCBalance.toString())
        .minus((await mockWBTC.balanceOf(owner.address)).toString())
        .div(parseUnits("1", 8).toString())
        .toString();
      expect(amountDeducted).equal(amountToDeduct);
    });

    it("Scenerio 2 - Close Auction", async function () {
      let auction = await shortfall.auctions(poolId);

      await mineNBlocks((await shortfall.nextBidderBlockLimit()).toNumber() + 2);

      //simulate transferReserveForAuction
      await mockBUSD.transfer(shortfall.address, auction.seizedRiskFund);

      await shortfall.closeAuction(poolId);
      auction = await shortfall.auctions(poolId);
      expect(auction.status).equal(2);

      expect(vWBTC.badDebtRecovered).to.have.been.calledTwice;
      expect(vWBTC.badDebtRecovered).to.have.been.calledWith(parseUnits("1", 8));

      expect(vDAI.badDebtRecovered).to.have.been.calledTwice;
      expect(vDAI.badDebtRecovered).to.have.been.calledWith(parseUnits("10000", 18));
    });
  });
});
