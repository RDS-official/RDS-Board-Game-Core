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
import './suites/room';
import './suites/clock';
import './suites/catan';
import './suites/sessionRoom';
import './suites/rules';
import './suites/splendor';
import './suites/splendorExpansions';
import './suites/rulesBetrayal';

export { AssertionError, runCoreSuite } from './testKit';
export type { SuiteCaseResult, SuiteResult } from './testKit';
