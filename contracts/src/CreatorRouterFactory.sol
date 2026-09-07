// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {CreatorRouter} from "./CreatorRouter.sol";

/**
 * Deploys a {CreatorRouter}, so the launchpad does not have to.
 *
 * ## ⛔⛔ THIS EXISTS FOR ONE MEASURED REASON: EIP-170
 *
 * A contract that writes `new CreatorRouter(...)` embeds the router's ENTIRE creation code in its
 * own runtime bytecode — that is what a `new` expression compiles to. With both the distributor and
 * the router inlined, `CharityLaunchpadV2` measured **29,206 bytes against the 24,576 limit**, and
 * it could not be deployed at all: the create reverts `CreateContractSizeLimit`.
 *
 * ⚠ `via_ir` was the first thing tried, because it is what solved the same problem on PONSPAD
 * (25,236 → 22,724 there). It does not close a 4,630 byte gap, and neither does `optimizer_runs`.
 * Moving one `new` behind a call does, because the creation code moves with it.
 *
 * ## ⭐ PERMISSIONLESS, AND SAFE BECAUSE OF WHERE THE TRUST ACTUALLY SITS
 *
 * Anybody may call {deploy}. A router deployed by a stranger is inert: {CreatorRouter.initialize}
 * binds only to a token that OUR launchpad registered, whose distributor names that exact router as
 * its `opsVault`. A stranger can make routers all day and none of them can ever attach to a launch.
 *
 * ⛔ So this contract holds no permissions and needs none. Making it `onlyLaunchpad` would buy
 * nothing and would mean redeploying it the day the launchpad is replaced.
 */
contract CreatorRouterFactory {
    event RouterDeployed(address indexed router, address indexed launchpad);

    /**
     * @param ponsFactory Pons's live launch factory, which the router reads a launch record from.
     * @param launchpad   The charity launchpad whose registry the router pins itself against.
     * @param claims      Where an X or GitHub share is ring-fenced. May be zero when unused.
     * @param poolManager Uniswap V4's singleton, for a burn after graduation.
     * @param splits      ⛔ Fixed for ever: they become part of the router's address and therefore
     *                    part of what the token itself commits to.
     */
    function deploy(
        address ponsFactory,
        address launchpad,
        address claims,
        address poolManager,
        CreatorRouter.Split[] memory splits
    ) external returns (address router) {
        router = address(new CreatorRouter(ponsFactory, launchpad, claims, poolManager, splits));
        emit RouterDeployed(router, launchpad);
    }
}
