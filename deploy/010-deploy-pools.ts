import { ethers } from "hardhat";
import { DeployResult } from "hardhat-deploy/dist/types";
import { DeployFunction } from "hardhat-deploy/types";
import { json } from "hardhat/internal/core/params/argumentTypes";
import { HardhatRuntimeEnvironment } from "hardhat/types";

import { getConfig, getTokenConfig } from "../helpers/deploymentConfig";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  const proxyAdmin = (await ethers.getContract("DefaultProxyAdmin")).address;

  let tx;
  const priceOracle = await ethers.getContract("ResilientOracle");
  const poolRegistry = await ethers.getContract("PoolRegistry");
  const accessControlManager = await ethers.getContract("AccessControlManager");
  const maxLoopsLimit = 150;

  // Comptroller Beacon
  const comptrollerImpl: DeployResult = await deploy("ComptrollerImpl", {
    contract: "Comptroller",
    from: deployer,
    args: [poolRegistry.address],
    log: true,
    autoMine: true,
  });

  const ComptrollerBeacon: DeployResult = await deploy("ComptrollerBeacon", {
    contract: "Beacon",
    from: deployer,
    args: [comptrollerImpl.address],
    log: true,
    autoMine: true,
  });

  // VToken Beacon
  const vTokenImpl: DeployResult = await deploy("VtokenImpl", {
    contract: "VToken",
    from: deployer,
    args: [],
    log: true,
    autoMine: true,
  });

  const vTokenBeacon: DeployResult = await deploy("VTokenBeacon", {
    contract: "Beacon",
    from: deployer,
    args: [vTokenImpl.address],
    log: true,
    autoMine: true,
  });

  const { tokensConfig, poolConfig } = await getConfig(hre.network.name);
  let pools = await poolRegistry.callStatic.getAllPools();

  for (let i = 0; i < poolConfig.length; i++) {
    const pool = poolConfig[i];
    let comptrollerProxy;

    if (i >= pools.length) {
      // Create pool
      console.log("Registering new pool with name " + pool.name);
      tx = await poolRegistry.createRegistryPool(
        pool.name,
        ComptrollerBeacon.address,
        pool.closeFactor,
        pool.liquidationIncentive,
        pool.minLiquidatableCollateral,
        priceOracle.address,
        maxLoopsLimit,
        accessControlManager.address,
      );
      await tx.wait();
      console.log("New Pool Registered");
      pools = await poolRegistry.callStatic.getAllPools();
      comptrollerProxy = await ethers.getContractAt("Comptroller", pools[i].comptroller);
      tx = await comptrollerProxy.acceptOwnership();
      await tx.wait();
    } else {
      comptrollerProxy = await ethers.getContractAt("Comptroller", pools[i].comptroller);
    }

    // Add Markets
    for (const vtoken of pool.vtokens) {
      const {
        name,
        asset,
        symbol,
        rateModel,
        baseRatePerYear,
        multiplierPerYear,
        jumpMultiplierPerYear,
        kink_,
        collateralFactor,
        liquidationThreshold,
        reserveFactor,
        initialSupply,
        supplyCap,
        borrowCap,
      } = vtoken;

      const token = getTokenConfig(asset, tokensConfig);
      let tokenContract;
      if (token.isMock) {
        tokenContract = await ethers.getContract(`Mock${token.symbol}`);
        console.log("Minting " + initialSupply + " mock tokens to owner");
        tx = await tokenContract.faucet(initialSupply);
        await tx.wait(1);
      } else {
        tokenContract = await ethers.getContractAt(
          "@openzeppelin/contracts/token/ERC20/ERC20.sol:ERC20",
          token.tokenAddress,
        );
        // Make sure that deployer has at least `initialSupply` balance of the token
      }

      console.log("Approving PoolRegistry for: " + initialSupply);
      tx = await tokenContract.approve(poolRegistry.address, initialSupply);
      await tx.wait(1);

      console.log("Adding market " + name);

      tx = await poolRegistry.addMarket({
        comptroller: comptrollerProxy.address,
        asset: tokenContract.address,
        decimals: 8,
        name: name,
        symbol: symbol,
        rateModel: rateModel,
        baseRatePerYear: baseRatePerYear,
        multiplierPerYear: multiplierPerYear,
        jumpMultiplierPerYear: jumpMultiplierPerYear,
        kink_: kink_,
        collateralFactor: collateralFactor,
        liquidationThreshold: liquidationThreshold,
        reserveFactor: reserveFactor,
        accessControlManager: accessControlManager.address,
        vTokenProxyAdmin: proxyAdmin,
        beaconAddress: vTokenBeacon.address,
        initialSupply: initialSupply,
        supplyCap: supplyCap,
        borrowCap: borrowCap,
      });
      await tx.wait();
      console.log(`Market ${name} added to pool ${pool.name}`);
    }
  }
};

func.tags = ["Pools", "il"];

export default func;
