import type { Scenario } from '../shared/spec.ts';
import { SimulatedModel } from './simulated-model.ts';

/** Deterministic local test double; retains its legacy fixture-topic behavior. */
export class TestModel extends SimulatedModel {
  constructor(scenario: Scenario) {
    super(scenario, { profile: 'test' });
  }
}
