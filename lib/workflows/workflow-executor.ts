import type { AgentExecutor } from '../agents/agent-executor.js';
import type { AgentLoader } from '../agents/agent-loader.js';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowContext,
  WorkflowResult,
  StepResult,
  ParallelSteps,
  WorkflowStatus,
} from './types.js';

export class WorkflowExecutor {
  private agentLoader: AgentLoader;
  private agentExecutor: AgentExecutor;

  constructor(agentLoader: AgentLoader, agentExecutor: AgentExecutor) {
    this.agentLoader = agentLoader;
    this.agentExecutor = agentExecutor;
  }

  async execute(
    definition: WorkflowDefinition,
    input: Record<string, unknown>,
    onStatus?: (status: WorkflowStatus) => void
  ): Promise<WorkflowResult> {
    const startTime = Date.now();
    const context: WorkflowContext = {
      input: this.applyDefaults(definition, input),
      steps: {},
      vectors: {},
    };

    const totalSteps = definition.steps.length;
    let stepsExecuted = 0;
    let success = true;

    onStatus?.({
      type: 'workflow_start',
      message: `Starting workflow: ${definition.name}`,
      progress: { current: 0, total: totalSteps },
      elapsed: 0,
    });

    for (const stepDef of definition.steps) {
      try {
        if (this.isParallelSteps(stepDef)) {
          onStatus?.({
            type: 'step_start',
            stepId: 'parallel',
            message: `Executing ${stepDef.parallel.length} steps in parallel`,
            progress: { current: stepsExecuted, total: totalSteps },
            elapsed: Date.now() - startTime,
          });

          const results = await this.executeParallel(stepDef.parallel, context);
          for (const [id, result] of Object.entries(results)) {
            context.steps[id] = result;
            stepsExecuted++;

            onStatus?.({
              type: result.metadata.success ? 'step_complete' : 'step_error',
              stepId: id,
              agent: result.metadata.agent,
              message: result.metadata.success
                ? `Step "${id}" completed successfully`
                : `Step "${id}" failed: ${result.metadata.error || 'Unknown error'}`,
              progress: { current: stepsExecuted, total: totalSteps },
              elapsed: Date.now() - startTime,
              error: result.metadata.error,
            });
          }
        } else {
          onStatus?.({
            type: 'step_start',
            stepId: stepDef.id,
            agent: stepDef.agent,
            message: `Starting step "${stepDef.id}" with agent "${stepDef.agent}"`,
            progress: { current: stepsExecuted, total: totalSteps },
            elapsed: Date.now() - startTime,
          });

          const result = await this.executeStep(stepDef, context);
          context.steps[stepDef.id] = result;
          stepsExecuted++;

          onStatus?.({
            type: result.metadata.success ? 'step_complete' : 'step_error',
            stepId: stepDef.id,
            agent: result.metadata.agent,
            message: result.metadata.success
              ? `Step "${stepDef.id}" completed in ${result.metadata.duration}ms`
              : `Step "${stepDef.id}" failed: ${result.metadata.error || 'Unknown error'}`,
            progress: { current: stepsExecuted, total: totalSteps },
            elapsed: Date.now() - startTime,
            error: result.metadata.error,
          });

          if (!result.metadata.success && definition.config?.onError === 'stop') {
            success = false;
            break;
          }
        }
      } catch (error) {
        success = false;
        const errorMessage = error instanceof Error ? error.message : String(error);
        onStatus?.({
          type: 'step_error',
          message: `Step execution error: ${errorMessage}`,
          progress: { current: stepsExecuted, total: totalSteps },
          elapsed: Date.now() - startTime,
          error: errorMessage,
        });

        if (definition.config?.onError === 'stop') {
          break;
        }
      }
    }

    const output = this.resolveOutput(definition, context);
    const duration = Date.now() - startTime;

    onStatus?.({
      type: success ? 'workflow_complete' : 'workflow_error',
      message: success
        ? `Workflow completed successfully in ${duration}ms`
        : `Workflow completed with errors in ${duration}ms`,
      progress: { current: stepsExecuted, total: totalSteps },
      elapsed: duration,
    });

    return {
      output,
      metadata: {
        duration,
        stepsExecuted,
        success,
      },
      stepResults: context.steps,
    };
  }

  private isParallelSteps(step: WorkflowStep | ParallelSteps): step is ParallelSteps {
    return 'parallel' in step;
  }

  private applyDefaults(
    definition: WorkflowDefinition,
    input: Record<string, unknown>
  ): Record<string, unknown> {
    const result: Record<string, unknown> = { ...input };

    for (const [key, field] of Object.entries(definition.input.schema)) {
      if (result[key] === undefined && field.default !== undefined) {
        result[key] = field.default;
      }
    }

    return result;
  }

  private async executeStep(
    step: WorkflowStep,
    context: WorkflowContext
  ): Promise<StepResult> {
    const startTime = Date.now();

    if (step.condition) {
      const conditionMet = this.evaluateCondition(step.condition, context);
      if (!conditionMet) {
        return {
          output: null,
          metadata: {
            duration: 0,
            agent: step.agent,
            success: true,
            error: 'Condition not met, step skipped',
          },
        };
      }
    }

    const agentDef = this.agentLoader.get(step.agent);
    if (!agentDef) {
      return {
        output: null,
        metadata: {
          duration: Date.now() - startTime,
          agent: step.agent,
          success: false,
          error: `Agent not found: ${step.agent}`,
        },
      };
    }

    const resolvedInput = this.resolveInput(step.input, context);

    try {
      const agent = await this.agentExecutor.createInstance(agentDef);
      const result = await agent.invoke(resolvedInput);

      return {
        output: result.output,
        metadata: {
          duration: Date.now() - startTime,
          agent: step.agent,
          success: true,
        },
      };
    } catch (error) {
      return {
        output: null,
        metadata: {
          duration: Date.now() - startTime,
          agent: step.agent,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private async executeParallel(
    steps: WorkflowStep[],
    context: WorkflowContext
  ): Promise<Record<string, StepResult>> {
    const results = await Promise.all(
      steps.map(async (step) => {
        const result = await this.executeStep(step, context);
        return { id: step.id, result };
      })
    );

    return Object.fromEntries(results.map(({ id, result }) => [id, result]));
  }

  private resolveInput(
    inputMapping: Record<string, unknown>,
    context: WorkflowContext
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(inputMapping)) {
      resolved[key] = this.resolveValue(value, context);
    }

    return resolved;
  }

  private resolveValue(value: unknown, context: WorkflowContext): unknown {
    if (typeof value === 'string') {
      return this.interpolateString(value, context);
    }

    if (typeof value === 'object' && value !== null && 'from' in value) {
      const mapping = value as { from: string; path: string };
      return this.resolvePath(mapping.from, mapping.path, context);
    }

    return value;
  }

  private interpolateString(template: string, context: WorkflowContext): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
      const trimmedPath = path.trim();
      const value = this.resolveTemplatePath(trimmedPath, context);
      return value !== undefined ? String(value) : '';
    });
  }

  private resolveTemplatePath(path: string, context: WorkflowContext): unknown {
    const parts = path.split('.');

    if (parts[0] === 'input') {
      return this.getNestedValue(context.input, parts.slice(1));
    }

    if (parts[0] === 'steps' && parts[1]) {
      const stepId = parts[1];
      const stepResult = context.steps[stepId];
      if (!stepResult) return undefined;

      if (parts[2] === 'output') {
        return this.getNestedValue(stepResult.output as Record<string, unknown>, parts.slice(3));
      }
      if (parts[2] === 'metadata') {
        return this.getNestedValue(stepResult.metadata as unknown as Record<string, unknown>, parts.slice(3));
      }

      return stepResult.output;
    }

    return undefined;
  }

  private resolvePath(from: string, path: string, context: WorkflowContext): unknown {
    switch (from) {
      case 'context':
        return this.getNestedValue(context as unknown as Record<string, unknown>, path.split('.'));
      case 'step': {
        const [stepId, ...rest] = path.split('.');
        const stepResult = stepId ? context.steps[stepId] : undefined;
        return stepResult ? this.getNestedValue(stepResult as unknown as Record<string, unknown>, rest) : undefined;
      }
      default:
        return undefined;
    }
  }

  private getNestedValue(obj: unknown, path: string[]): unknown {
    let current = obj;

    for (const key of path) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[key];
    }

    return current;
  }

  private evaluateCondition(condition: string, context: WorkflowContext): boolean {
    const interpolated = this.interpolateString(condition, context);

    try {
      if (interpolated === 'true') return true;
      if (interpolated === 'false') return false;
      return Boolean(interpolated);
    } catch {
      return false;
    }
  }

  private resolveOutput(
    definition: WorkflowDefinition,
    context: WorkflowContext
  ): Record<string, unknown> {
    const output: Record<string, unknown> = {};

    for (const [key, template] of Object.entries(definition.output)) {
      output[key] = this.interpolateString(template, context);
    }

    return output;
  }
}
