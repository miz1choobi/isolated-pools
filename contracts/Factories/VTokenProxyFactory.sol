// SPDX-License-Identifier: BSD-3-Clause
pragma solidity 0.8.13;

import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import "../VToken.sol";
import "../Governance/AccessControlManager.sol";
import "../VTokenInterfaces.sol";

contract VTokenProxyFactory {
    struct VTokenArgs {
        address underlying_;
        ComptrollerInterface comptroller_;
        InterestRateModel interestRateModel_;
        uint256 initialExchangeRateMantissa_;
        string name_;
        string symbol_;
        uint8 decimals_;
        address payable admin_;
        AccessControlManager accessControlManager_;
        VTokenInterface.RiskManagementInit riskManagement;
        address vTokenProxyAdmin_;
        VToken tokenImplementation_;
    }

    function deployVTokenProxy(VTokenArgs memory input) external returns (VToken) {
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(input.tokenImplementation_),
            input.vTokenProxyAdmin_,
            abi.encodeWithSelector(
                input.tokenImplementation_.initialize.selector,
                input.underlying_,
                input.comptroller_,
                input.interestRateModel_,
                input.initialExchangeRateMantissa_,
                input.name_,
                input.symbol_,
                input.decimals_,
                input.admin_,
                input.accessControlManager_,
                input.riskManagement
            )
        );
        return VToken(address(proxy));
    }
}