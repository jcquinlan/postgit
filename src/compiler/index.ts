import { Project, Node, CallExpression, AwaitExpression, PropertyAccessExpression, ForOfStatement } from "ts-morph";
import type { WorkflowNode, Ref, ForEachNode, KVGetNode, KVSetNode } from "../sdk/types";

const WORKFLOW_FUNCTIONS = new Set(["hitEndpoint", "sleep", "sendEmail", "failFor"]);

interface CompilerContext {
  stepCounter: number;
  variables: Map<string, string>; // variable name -> blackboard path
  kvStores: Map<string, string>;  // variable name -> store name
}

export function compileWorkflowFile(filePath: string): WorkflowNode {
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
    skipAddingFilesFromTsConfig: true,
  });

  const sourceFile = project.addSourceFileAtPath(filePath);
  
  const workflowFn = sourceFile.getFunction("workflow");
  if (!workflowFn) {
    throw new Error("Workflow file must export a function named 'workflow'");
  }

  if (!workflowFn.isAsync()) {
    throw new Error("workflow() must be an async function");
  }

  const body = workflowFn.getBody();
  if (!body || !Node.isBlock(body)) {
    throw new Error("workflow() must have a block body");
  }

  const ctx: CompilerContext = {
    stepCounter: 0,
    variables: new Map(),
    kvStores: new Map(),
  };

  const children = compileStatements(body.getStatements(), ctx);

  return {
    type: "Sequence",
    id: "root",
    props: {},
    children,
  };
}

function compileStatements(statements: Node[], ctx: CompilerContext): WorkflowNode[] {
  const children: WorkflowNode[] = [];
  for (const statement of statements) {
    const node = compileStatement(statement, ctx);
    if (node) {
      children.push(node);
    }
  }
  return children;
}

function compileStatement(statement: Node, ctx: CompilerContext): WorkflowNode | null {
  if (Node.isExpressionStatement(statement)) {
    const expr = statement.getExpression();
    if (Node.isAwaitExpression(expr)) {
      return compileAwaitExpression(expr, null, ctx);
    }
  }

  if (Node.isVariableStatement(statement)) {
    const declarations = statement.getDeclarations();
    if (declarations.length === 1) {
      const decl = declarations[0];
      const initializer = decl.getInitializer();
      const varName = decl.getName();
      
      if (initializer) {
        // Check for kv() call (not awaited)
        if (Node.isCallExpression(initializer)) {
          const callee = initializer.getExpression();
          if (Node.isIdentifier(callee) && callee.getText() === "kv") {
            const args = initializer.getArguments();
            if (args.length >= 1 && Node.isStringLiteral(args[0])) {
              const storeName = args[0].getLiteralValue();
              ctx.kvStores.set(varName, storeName);
              return null; // No node generated, just register the store
            }
            throw new Error("kv() requires a string literal store name");
          }
        }
        
        // Check for awaited expression
        if (Node.isAwaitExpression(initializer)) {
          return compileAwaitExpression(initializer, varName, ctx);
        }
      }
    }
  }

  if (Node.isForOfStatement(statement)) {
    return compileForOfStatement(statement, ctx);
  }

  if (Node.isReturnStatement(statement)) {
    return null;
  }

  console.warn(`Skipping unsupported statement: ${statement.getKindName()}`);
  return null;
}

function compileForOfStatement(statement: ForOfStatement, ctx: CompilerContext): ForEachNode {
  ctx.stepCounter++;
  const stepId = `loop_${ctx.stepCounter}`;

  const initializer = statement.getInitializer();
  let itemVar: string;

  if (Node.isVariableDeclarationList(initializer)) {
    const decls = initializer.getDeclarations();
    if (decls.length !== 1) {
      throw new Error("for...of loop must declare exactly one variable");
    }
    itemVar = decls[0].getName();
  } else {
    throw new Error("for...of loop must use variable declaration (const/let)");
  }

  const iterableExpr = statement.getExpression();
  let itemsPath: string | Ref;

  if (Node.isIdentifier(iterableExpr)) {
    const varName = iterableExpr.getText();
    const path = ctx.variables.get(varName);
    if (path) {
      itemsPath = { __ref: true, path } as Ref;
    } else {
      throw new Error(`Unknown variable in for...of: ${varName}`);
    }
  } else if (Node.isPropertyAccessExpression(iterableExpr)) {
    const path = resolvePropertyAccess(iterableExpr, ctx);
    itemsPath = { __ref: true, path } as Ref;
  } else {
    throw new Error(`Unsupported iterable expression: ${iterableExpr.getKindName()}`);
  }

  // Create a child context with the loop variable
  const childCtx: CompilerContext = {
    stepCounter: ctx.stepCounter,
    variables: new Map(ctx.variables),
    kvStores: new Map(ctx.kvStores),
  };
  // The loop variable references the current item in the iteration
  childCtx.variables.set(itemVar, `$.__item`);

  const loopBody = statement.getStatement();
  let bodyStatements: Node[];

  if (Node.isBlock(loopBody)) {
    bodyStatements = loopBody.getStatements();
  } else {
    bodyStatements = [loopBody];
  }

  const children = compileStatements(bodyStatements, childCtx);

  // Update parent counter
  ctx.stepCounter = childCtx.stepCounter;

  return {
    type: "ForEach",
    id: stepId,
    props: {
      items: itemsPath,
      itemVar,
    },
    children,
  };
}

function compileAwaitExpression(
  expr: AwaitExpression,
  assignTo: string | null,
  ctx: CompilerContext
): WorkflowNode | null {
  const inner = expr.getExpression();
  
  if (!Node.isCallExpression(inner)) {
    throw new Error(`Unsupported await expression: ${inner.getKindName()}`);
  }

  const callee = inner.getExpression();
  
  // Check for store.get() or store.set()
  if (Node.isPropertyAccessExpression(callee)) {
    const obj = callee.getExpression();
    const method = callee.getName();
    
    if (Node.isIdentifier(obj)) {
      const varName = obj.getText();
      const storeName = ctx.kvStores.get(varName);
      
      if (storeName) {
        if (method === "get") {
          return compileKVGet(inner, storeName, assignTo, ctx);
        } else if (method === "set") {
          return compileKVSet(inner, storeName, ctx);
        }
        throw new Error(`Unknown KV store method: ${method}`);
      }
    }
  }

  // Regular workflow function call
  let fnName: string;

  if (Node.isIdentifier(callee)) {
    fnName = callee.getText();
  } else if (Node.isPropertyAccessExpression(callee)) {
    fnName = callee.getName();
  } else {
    throw new Error(`Unsupported call expression: ${callee.getKindName()}`);
  }

  if (!WORKFLOW_FUNCTIONS.has(fnName)) {
    throw new Error(`Unknown workflow function: ${fnName}`);
  }

  ctx.stepCounter++;
  const stepId = `step_${ctx.stepCounter}`;

  if (assignTo) {
    ctx.variables.set(assignTo, `$.${assignTo}`);
  }

  switch (fnName) {
    case "hitEndpoint":
      return compileHitEndpoint(inner, stepId, assignTo, ctx);
    case "sleep":
      return compileSleep(inner, stepId, ctx);
    case "sendEmail":
      return compileSendEmail(inner, stepId, ctx);
    case "failFor":
      return compileFailFor(inner, stepId, ctx);
    default:
      throw new Error(`Unknown function: ${fnName}`);
  }
}

function compileKVGet(
  call: CallExpression,
  storeName: string,
  assignTo: string | null,
  ctx: CompilerContext
): KVGetNode {
  ctx.stepCounter++;
  const stepId = `kv_get_${ctx.stepCounter}`;

  const args = call.getArguments();
  if (args.length < 1) {
    throw new Error("store.get() requires a key argument");
  }

  const key = evaluateLiteral(args[0], ctx);

  if (assignTo) {
    ctx.variables.set(assignTo, `$.${assignTo}`);
  }

  return {
    type: "KVGet",
    id: stepId,
    props: {
      store: storeName,
      key: key as string | Ref,
      assignTo: assignTo ? `$.${assignTo}` : `$.${stepId}`,
    },
  };
}

function compileKVSet(
  call: CallExpression,
  storeName: string,
  ctx: CompilerContext
): KVSetNode {
  ctx.stepCounter++;
  const stepId = `kv_set_${ctx.stepCounter}`;

  const args = call.getArguments();
  if (args.length < 2) {
    throw new Error("store.set() requires key and value arguments");
  }

  const key = evaluateLiteral(args[0], ctx);
  const value = evaluateLiteral(args[1], ctx);

  return {
    type: "KVSet",
    id: stepId,
    props: {
      store: storeName,
      key: key as string | Ref,
      value,
    },
  };
}

function compileHitEndpoint(
  call: CallExpression,
  stepId: string,
  assignTo: string | null,
  ctx: CompilerContext
): WorkflowNode {
  const args = call.getArguments();
  
  if (args.length < 1) {
    throw new Error("hitEndpoint requires at least a URL argument");
  }

  const urlArg = args[0];
  const url = evaluateLiteral(urlArg, ctx);

  let method: string | undefined;
  let headers: Record<string, string> | undefined;
  let body: unknown;

  if (args.length > 1 && Node.isObjectLiteralExpression(args[1])) {
    const opts = args[1];
    for (const prop of opts.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        const name = prop.getName();
        const value = prop.getInitializer();
        if (value) {
          if (name === "method") method = evaluateLiteral(value, ctx) as string;
          else if (name === "headers") headers = evaluateLiteral(value, ctx) as Record<string, string>;
          else if (name === "body") body = evaluateLiteral(value, ctx);
        }
      }
    }
  }

  return {
    type: "HitEndpoint",
    id: stepId,
    props: {
      url: url as string,
      method,
      headers,
      body,
      assignTo: assignTo ? `$.${assignTo}` : `$.${stepId}`,
    },
  };
}

function compileSleep(call: CallExpression, stepId: string, ctx: CompilerContext): WorkflowNode {
  const args = call.getArguments();
  
  if (args.length < 1) {
    throw new Error("sleep requires a seconds argument");
  }

  const seconds = evaluateLiteral(args[0], ctx);

  if (typeof seconds !== "number") {
    throw new Error("sleep argument must be a number");
  }

  return {
    type: "Sleep",
    id: stepId,
    props: { seconds },
  };
}

function compileFailFor(call: CallExpression, stepId: string, ctx: CompilerContext): WorkflowNode {
  const args = call.getArguments();
  
  if (args.length < 1) {
    throw new Error("failFor requires a times argument");
  }

  const times = evaluateLiteral(args[0], ctx);

  if (typeof times !== "number") {
    throw new Error("failFor argument must be a number");
  }

  return {
    type: "FailFor",
    id: stepId,
    props: { times },
  };
}

function compileSendEmail(call: CallExpression, stepId: string, ctx: CompilerContext): WorkflowNode {
  const args = call.getArguments();
  
  if (args.length < 1 || !Node.isObjectLiteralExpression(args[0])) {
    throw new Error("sendEmail requires an options object");
  }

  const opts = args[0];
  let to: string | Ref | undefined;
  let subject: string | Ref | undefined;
  let body: string | Ref | undefined;

  for (const prop of opts.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = prop.getName();
      const value = prop.getInitializer();
      if (value) {
        const evaluated = evaluateLiteral(value, ctx);
        if (name === "to") to = evaluated as string | Ref;
        else if (name === "subject") subject = evaluated as string | Ref;
        else if (name === "body") body = evaluated as string | Ref;
      }
    }
  }

  if (!to || !subject || !body) {
    throw new Error("sendEmail requires to, subject, and body");
  }

  return {
    type: "SendEmail",
    id: stepId,
    props: { to, subject, body },
  };
}

function evaluateLiteral(node: Node, ctx: CompilerContext): unknown {
  if (Node.isStringLiteral(node)) {
    return node.getLiteralValue();
  }

  if (Node.isNumericLiteral(node)) {
    return node.getLiteralValue();
  }

  if (Node.isTrueLiteral(node)) {
    return true;
  }

  if (Node.isFalseLiteral(node)) {
    return false;
  }

  if (Node.isNullLiteral(node)) {
    return null;
  }

  if (Node.isIdentifier(node)) {
    const name = node.getText();
    const path = ctx.variables.get(name);
    if (path) {
      return { __ref: true, path } as Ref;
    }
    throw new Error(`Unknown variable: ${name}`);
  }

  if (Node.isPropertyAccessExpression(node)) {
    const path = resolvePropertyAccess(node, ctx);
    return { __ref: true, path } as Ref;
  }

  if (Node.isObjectLiteralExpression(node)) {
    const result: Record<string, unknown> = {};
    for (const prop of node.getProperties()) {
      if (Node.isPropertyAssignment(prop)) {
        const name = prop.getName();
        const value = prop.getInitializer();
        if (value) {
          result[name] = evaluateLiteral(value, ctx);
        }
      }
    }
    return result;
  }

  if (Node.isArrayLiteralExpression(node)) {
    return node.getElements().map((el) => evaluateLiteral(el, ctx));
  }

  if (Node.isTemplateExpression(node)) {
    throw new Error("Template literals with expressions are not yet supported. Use string concatenation or a simple ref.");
  }

  if (Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }

  throw new Error(`Cannot evaluate expression: ${node.getKindName()} - ${node.getText()}`);
}

function resolvePropertyAccess(node: PropertyAccessExpression, ctx: CompilerContext): string {
  const parts: string[] = [];
  let current: Node = node;

  while (Node.isPropertyAccessExpression(current)) {
    parts.unshift(current.getName());
    current = current.getExpression();
  }

  if (Node.isIdentifier(current)) {
    const varName = current.getText();
    const basePath = ctx.variables.get(varName);
    if (basePath) {
      return `${basePath}.${parts.join(".")}`;
    }
    throw new Error(`Unknown variable: ${varName}`);
  }

  throw new Error(`Cannot resolve property access: ${node.getText()}`);
}
