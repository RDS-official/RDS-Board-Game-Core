/* -------------------------------------------------------------------------- */
/* Core conformance suite entry point.                                        */
/* The suites/ modules register their cases on import, in this exact order.   */
/* -------------------------------------------------------------------------- */

import './suites/corePrimitives';
import './suites/decisionsObserver';
import './suites/engine';
import './suites/expansions';
import './suites/fixtureConformance';
import './suites/betrayal';
import './suites/kernelRollWindow';
import './suites/betrayalChecks';
import './suites/bots';
import './suites/presentation';
import './suites/isolation';
import './suites/room';
import './suites/clock';
import './suites/catan';
import './suites/sessionRoom';
import './suites/rules';
import './suites/splendor';
import './suites/splendorExpansions';
import './suites/poker';
import './suites/charter';
import './suites/rulesBetrayal';
import './suites/diagnostics';
// Keep the Sanguosha regression suite last: the shard runner assigns case
// indices modulo shard count, and inserting cases before the heavyweight
// Splendor/Poker blocks would reshuffle those blocks across shards.
import './suites/sanguosha';

export { AssertionError, runCoreSuite } from './testKit';
export type { SuiteCaseResult, SuiteResult } from './testKit';
