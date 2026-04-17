#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Canon bridge bootstrap.
 * Runtime implementation lives in `runtime/main.ts`.
 */
import { startCanonBridgeServer } from './runtime/main';

startCanonBridgeServer();

