import React from 'react';
import './App.css';
import { Controlled as ControlledCodeMirror } from 'react-codemirror2';
import 'codemirror/lib/codemirror.css';
import 'codemirror/theme/material.css';
import 'codemirror/mode/python/python';
import RawCodeMirror from 'codemirror';
import SplitPane from 'react-split-pane';
import Collapsible from 'react-collapsible';

import init, {
  get_indices,
  perform_simulation,
  init_panic_hook,
} from './wasm-build/libsnpspice.js';

let wasmInitialized = false;
let wasm = init(process.env.PUBLIC_URL + "/libsnpspice_bg.wasm")
  .then(() => {
    wasmInitialized = true;
    init_panic_hook();
  });

interface ECompFet {
  kind: 'fet';
  isPfet: boolean;
  gate: string;
  drain: string;
  source: string;
}

interface EPullResistor {
  kind: 'pull_resistor';
  direction: 'up' | 'down';
  net: string;
}

interface EProbe {
  kind: 'probe';
  label: string;
  net: string;
}

interface EWire {
  kind: 'wire';
  nets: string[];
}

interface EButton {
  kind: 'button';
  net: string;
}

interface ESignal {
  kind: 'signal';
  net: string;
  pattern: ('0' | '1' | 'z')[];
  repeat: boolean;
}

type EComponent = (
  ECompFet |
  EPullResistor |
  EProbe |
  EWire |
  EButton |
  ESignal
);

//import createPlotlyComponent from "react-plotly.js/factory";

//// Importing plotly is a little bit of a nightmare.
//// If we just try to directly `import Plot from "react-plotly.js"` then webpack runs out of memory trying to build.
//const Plotly = require('plotly.js/lib/core');
//Plotly.register([
//    require('plotly.js/lib/heatmap'),
//]);
//const Plot = createPlotlyComponent(Plotly);

function builtinRead(x: string) {
  const Sk = (window as any).Sk;
  if (Sk.builtinFiles === undefined || Sk.builtinFiles["files"][x] === undefined)
    throw "File not found: '" + x + "'";
  return Sk.builtinFiles["files"][x];
}

const pyPrefix = `
vdd = "vdd";
gnd = "gnd";

def nfet(gate, drain, source):
  pass

def pfet(gate, drain, source):
  pass
`;

const startingCode = `# This is "Python" (Skulpt).
# To build up your solution to the puzzle simply call the functions documented below to emit circuit components.
#
# You have the following functions:
#
#   new_net(name_prefix: Optional[str] = 'net') -> Net
#     Creates a new unique net, with an optional name prefix.
#
#   nfet(gate: Net, drain: Net, source: Optional[Net])
#     Emits an n-channel FET into the circuit (pulls drain down to source when gate is high).
#     If the source is omitted it defaults to gnd.
#     It is a CMOS design rule violation if source can somehow be pulled high.
#
#   pfet(gate: Net, drain: Net, source: Optional[Net])
#     Emits a p-channel FET into the circuit (pulls drain up to source when gate is low).
#     If the source is omitted it defaults to vdd.
#     It is a CMOS design rule violation if source can somehow be pulled low.
#
#   probe(label: str, net: Net)
#     Marks the net to be plotted. Has no electrical effect.
#
#   wire_together(nets: List[Net])
#     Electrically connects all of the listed nets.
#
#   button(label: Optional[str]) -> Net
#     Emits a one-terminal push button, and return the button's output net.
#     When the button is pushed the net is pulled high, and when released pulled low.
#
#   signal(pattern: str) -> Net
#     Emits a signal generator component, and return the generator's output net.
#     The pattern must be made of 0s, 1s, and zs, and may optionally end with ... to indicate that the pattern should repeat.
#     If the 
#     The value z indicates that the signal shouldn't drive the output (high Z).
#     Examples:
#       clock = signal('01...') # Creates a clock signal that toggles every time step.
#       output = signal('zzz1z') # Waits three time steps, then drives high, then stops driving forever.
#
# The net gnd is always low, and the net vdd is always high.

# Create an inverter.
output = new_net()
clock = signal('01...')
nfet(clock, output, gnd)
pfet(clock, output, vdd)
probe('clock', clock)
probe('inverter output', output)
`

require("./simple.js").addDefineSimpleMode(RawCodeMirror);

(RawCodeMirror as any).defineSimpleMode("complang", {
  start: [
    // Match strings.
    { regex: /"(?:[^\\]|\\.)*?(?:"|$)/, token: "string" },
    // Match keywords.
    { regex: /(?:pfet|nfet|probe|wire|button|signal)\b/, token: "keyword" },
    // Match initialization and driving.
    //{regex: /~|<-/, token: "drive"},
    // Match built-ins.
    { regex: /(?:vdd|gnd)\b/, token: "builtin" },
    /*
    {regex: /(?:Slider|Selector|Checkbox|Uniform|Gaussian|Gamma|Beta|Frechet|PoissonProcess|WienerProcess|WienerDerivative|WienerDerivativeUnstable|D|Integrate|exp|log|sin|cos|sqrt|abs|floor|ceil|round|min|max|select|len|str|addDeriv|subDeriv|index_interpolating|print)\b/, token: "builtin"},
    {regex: /(?:globalTime|globalStepSize|e|pi|true|false|backend|tolerance|stepsize|maxplotpoints|integrator|simtime|minstep|maxstep|mcsamples|mctraces|mcenvelope|randomseed|processscale|mcpercentile|prefix|unitname|redrawperiod|crossoverprob|diffweight|populationsize|maxsteps|patience|patiencefactor|objectiveaggregation)\b/, token: "atom"},
    */
    // Match embedded javascript.
    //{regex: /javascript\s{/, token: "meta", mode: {spec: "javascript", end: /}/}},
    // Match numbers.
    { regex: /[01]+[.][.][.]/i, token: "number" },
    { regex: /0x[a-f\d]+|[-+]?(?:\.\d+|\d+\.?\d*)(?:e[-+]?\d+)?/i, token: "number" },
    // Match units.
    { regex: /`.*`/, token: "units" },
    // Handle comments.
    { regex: /\/\/.*/, token: "comment" },
    //{regex: /\/\*/, token: "comment", next: "comment"},
    // Match operators.
    { regex: /[-+\/*=<>!~]+/, token: "operator" },
    // Match compile-time variables.
    { regex: /\$[a-zA-Z_][a-zA-Z0-9_']*/, token: "compilevar" },
    // Match variables.
    { regex: /[a-zA-Z_][a-zA-Z0-9_']*/, token: "neutral" },
    // Indent and dedent on list/dict literals.
    { regex: /[\{\[\(]/, indent: true },
    { regex: /[\}\]\)]/, dedent: true },
  ],
  comment: [
    { regex: /.*?\*\//, token: "comment", next: "start" },
    { regex: /.*/, token: "comment" }
  ],
  meta: {
    dontIndentStates: ["comment"],
    lineComment: "//",
  },
});

class UnionFind<Key> {
  weights = new Map<Key, number>();
  parents = new Map<Key, Key>();

  canonicalize(k: Key): Key {
    if (!this.weights.has(k)) {
      this.weights.set(k, 1);
      this.parents.set(k, k);
    }

    const path = [k];
    let root = this.parents.get(k)!;
    while (root !== path[path.length - 1]) {
      path.push(root);
      root = this.parents.get(root)!;
    }

    for (const node of path)
      this.parents.set(node, root);
    return root;
  }

  union(...keys: Key[]) {
    if (keys.length === 0)
      return;
    const roots = keys.map((k) => this.canonicalize(k));
    // Find the heaviest.
    let totalWeight = 0;
    let heaviest = null as unknown as Key;
    let heaviestWeight = 0;
    for (const root of roots) {
      const weight = this.weights.get(root)!;
      totalWeight += weight;
      if (weight > heaviestWeight) {
        heaviest = root;
        heaviestWeight = weight;
      }
    }
    // Reweight and reparent.
    this.weights.set(heaviest!, totalWeight);
    for (const root of roots) {
      if (root !== heaviest) {
        this.parents.set(root, heaviest);
      }
    }
  }
}

function renderTraces(simResults: ISimResults, grading: IGrading) {
  const width = 800;
  const height = 30 * (simResults.probes.length + 1);

  const svgContents = [];

  let probeIndex = 0;
  const xStep = 5;

  for (const probe of simResults.probes) {
    const forwardPass: string[] = [];
    const backwardPass: string[] = [];
    let i = 0;
    let shootThroughStart = -1;
    const trace = simResults.netTraces.get(probe.net)!;
    for (const traceVal of trace) {
      const x = 3 + i * xStep;
      let yMin = 3;
      let yMax = 27;
      if (traceVal === 0) {
      } else if (traceVal === 1) {
        yMin = yMax = 27;
      } else if (traceVal === 2) {
        yMin = yMax = 3;
      } else if (traceVal === 3) {
        shootThroughStart = x;
      }
      if (i === 0)
        forwardPass.push(`M ${x} ${yMax}`);
      else
        forwardPass.push(`L ${x} ${yMax}`);
      backwardPass.push(`L ${x} ${yMin}`);
      i++;
      if (shootThroughStart >= 0)
        break;
    }
    backwardPass.reverse();
    backwardPass.push('Z');

    svgContents.push(
      <g key={probeIndex} transform={`translate(140 ${probeIndex * 30})`}>
        <text x={-140} y={20} stroke='white' fill='white'>{probe.label}</text>
        <path
          d={[...forwardPass, ...backwardPass].join(' ')}
          stroke='white'
          strokeWidth={3}
          fill='rgba(255, 255, 255, 0.3)'
        />
        {
          shootThroughStart !== -1 && <>
            <path
              d={`M ${shootThroughStart} 3 L ${shootThroughStart + 110} 3 L ${shootThroughStart + 110} 27 L ${shootThroughStart} 27 Z`}
              stroke='red'
              strokeWidth={3}
              fill='rgba(255, 0, 0, 0.3)'
            />
            <text x={shootThroughStart + 5} y={20} stroke='red' fill='red'>Shoot through!</text>
          </>
        }
      </g>
    );
    probeIndex++;
  }

  const errorX = 143 + xStep * grading.failureTime;

  return <svg style={{
    width: '100%', height,
  }}>
    {svgContents}
    {!grading.success && <>
      <path
        d={`M ${errorX} 0 L ${errorX} ${height - 20}`}
        stroke='red'
        strokeWidth={2}
        fill='transparent'
      />
      <text textAnchor='middle' x={errorX} y={height - 5} stroke='red' fill='red'>{grading.miniMessage}</text>
    </>}
  </svg>;
}

function persistLevelState(levelInternalName: string, levelState: ILevelState) {
  localStorage.setItem('level-' + levelInternalName + '-meta', JSON.stringify(levelState.metadata));
  localStorage.setItem('level-' + levelInternalName + '-saved-code', levelState.code);
}

function resetGameState() {
  localStorage.clear();
}

interface ILevel {
  internalName: string;
  name: string;
  levelDesc: string;
  startingCode: string;
  makeInputNets: (components: EComponent[]) => any[];
  makeOutputNets: (components: EComponent[]) => any[];
  gradeResults: (simResults: ISimResults) => IGrading;
}

function doGrading(
  simResults: ISimResults,
  tracesToGrade: { net: string, netName: string, reqs: [number, number][] }[],
): IGrading {
  for (const { net, netName, reqs } of tracesToGrade) {
    const trace = simResults.netTraces.get(net)!;
    for (const [time, value] of reqs) {
      if (trace[time] !== value) {
        const mapping = {0: 'undriven', 1: 'low', 2: 'high'} as any;
        const got = mapping[trace[time]];
        const wanted = mapping[value];
        let message = `${netName} is ${got}, but should have been ${wanted}.`;
        let miniMessage = `${netName} should be ${wanted}`;
        return { success: false, failureTime: time, message, miniMessage };
      }
    }
  }
  return { success: true, failureTime: 0, message: 'All tests passed!', miniMessage: '' };
}

const globalLevelsList: ILevel[] = [
  {
    internalName: 'fets',
    name: 'FETs',
    levelDesc: `Welcome to make-a-processor. In each level you must use FETs to construct a circuit that passes the test. The objective for the level will always be in this box.

You construct circuits by writing a "Python" program in the left pane that emits components. You can run your program by hitting ctrl+enter in the code pane. The program's output will appear in the bottom right pane, and the results of the circuit simulation will appear in the top right page.

To get a list of components, and to see how to emit them, open up the components pane.

Your goal in this first level is to use two FETs to drive the \`not_A\` net to be high when \`A\` is low, and vice versa.`,
    startingCode: `# Your Python code here.

# The nets vdd and gnd are built in, and are always 1 and 0 respectively.
probe("Power", vdd)
probe("Ground", gnd)

A, = get_level_inputs()
not_A, = get_level_outputs()

probe("A", A)
probe("¬A", not_A)

# Hint:
# nfet(gate, drain, source)
# pfet(gate, drain, source)
`,
    makeInputNets: (components: EComponent[]) => {
      components.push(
        { kind: 'signal', net: '_net_A', pattern: [...'01'] as any, repeat: true },
      );
      return ['_net_A'];
    },
    makeOutputNets: () => ['_net_not_A'],
    gradeResults: (simResults: ISimResults) => doGrading(simResults, [
      {
        net: '_net_not_A',
        netName: '¬A',
        reqs: [[7, 2], [17, 1], [27, 2], [37, 1]],
      }
    ]),
  },

  {
    internalName: 'highz',
    name: 'High-Z Output',
    levelDesc: `A component's output is said to be high Z (high impedance) when it isn't driven by the component. In this level you must construct a gated inverter that takes a second \`output_enable\` signal. Your gated inverter must drive the output if and only if \`output_enable\` is high.

Specifically, your component's truth table must be:

  A | OE | out
  -------------
  0 | 0  |  Z
  1 | 0  |  Z
  0 | 1  |  1
  1 | 1  |  0
`,
    startingCode: `A, output_enable = get_level_inputs()
not_A, = get_level_outputs()

probe("Output enable", output_enable)
probe("A", A)
probe("¬A", not_A)
`,
    makeInputNets: (components: EComponent[]) => {
      components.push(
        { kind: 'signal', net: '_net_A',             pattern: [...'z01001010'] as any, repeat: false },
        { kind: 'signal', net: '_net_output_enable', pattern: [...'000011100'] as any, repeat: false },
      );
      return ['_net_A', '_net_output_enable'];
    },
    makeOutputNets: () => ['_net_not_A'],
    gradeResults: (simResults: ISimResults) => doGrading(simResults, [
      {
        net: '_net_not_A',
        netName: '¬A',
        reqs: [[7, 0], [17, 0], [27, 0], [37, 0], [47, 2], [57, 1], [67, 2], [77, 0]],
      }
    ]),
  },

  {
    internalName: 'logic_gates',
    name: 'Logic Gates',
    levelDesc: `We will now create logic gates. Implement `,
    startingCode: `
def not_gate(x):
    r = new_net()
    ...
    return r
`,
    makeInputNets: () => ['_net_A', '_net_output_enable'],
    makeOutputNets: () => ['_net_notA'],
    gradeResults: (x: any) => ({ success: false, failureTime: 3, message: 'bad', miniMessage: '?' }),
  },
  {
    internalName: 'adder',
    name: 'Adder',
    levelDesc: `This is the first level.
To open up the documentation press `,
    startingCode: '# Your code here.\n',
    makeInputNets: () => ['_net_A', '_net_output_enable'],
    makeOutputNets: () => ['_net_notA'],
    gradeResults: (x: any) => ({ success: false, failureTime: 3, message: 'bad', miniMessage: '?' }),
  },
  {
    internalName: 'flipflops',
    name: 'Flip-Flops',
    levelDesc: `This is the first level.
To open up the documentation press `,
    startingCode: '# Your code here.\n',
    makeInputNets: () => ['_net_A', '_net_output_enable'],
    makeOutputNets: () => ['_net_notA'],
    gradeResults: (x: any) => ({ success: false, failureTime: 3, message: 'bad', miniMessage: '?' }),
  },
  {
    internalName: 'state_machine',
    name: 'State Machines',
    levelDesc: `This is the first level.
To open up the documentation press `,
    startingCode: '# Your code here.\n',
    makeInputNets: () => ['_net_A', '_net_output_enable'],
    makeOutputNets: () => ['_net_notA'],
    gradeResults: (x: any) => ({ success: false, failureTime: 3, message: 'bad', miniMessage: '?' }),
  },
  {
    internalName: 'sram',
    name: 'SRAM',
    levelDesc: `This is the first level.
To open up the documentation press `,
    startingCode: '# Your code here.\n',
    makeInputNets: () => ['_net_A', '_net_output_enable'],
    makeOutputNets: () => ['_net_notA'],
    gradeResults: (x: any) => ({ success: false, failureTime: 3, message: 'bad', miniMessage: '?' }),
  },
  {
    internalName: 'microprocessor',
    name: 'Microprocessor',
    levelDesc: `This is the first level.
To open up the documentation press `,
    startingCode: '# Your code here.\n',
    makeInputNets: () => ['_net_A', '_net_output_enable'],
    makeOutputNets: () => ['_net_notA'],
    gradeResults: (x: any) => ({ success: false, failureTime: 3, message: 'bad', miniMessage: '?' }),
  },
];

interface ISimResults {
  components: number;
  nets: string[];
  netTraces: Map<string, Uint8Array>;
  probes: EProbe[];
  shootThroughOccurred: boolean;
  earliestShootThrough: number;
}

interface ILevelState {
  metadata: {
    savedVersion: number;
    everOpened: boolean;
    everBeaten: boolean;
  };
  code: string;
}

interface IGrading {
  success: boolean;
  failureTime: number;
  message: string;
  miniMessage: string;
}

interface IAppState {
  page: 'level-select' | 'level';
  currentLevel: ILevel;
  code: string;
  terminalOutput: string;
  simOutput: string;
  simResults: null | ISimResults;
  grading: null | IGrading;
}

class App extends React.PureComponent<{}, IAppState> {
  levelStates: Map<string, ILevelState>;

  constructor(props: {}) {
    super(props);

    // Load level states from localStorage.
    this.levelStates = new Map<string, ILevelState>(); // Silence the error.
    this.loadLevelStatesFromLocalStorage();

    this.state = {
      page: 'level-select',
      currentLevel: null as unknown as ILevel,
      code: '',
      terminalOutput: '',
      simOutput: '',
      simResults: null,
      grading: null,
    };

    window.onpopstate = (event) => {
      this.setState({
        page: 'level-select',
      })
    };
  }

  loadLevelStatesFromLocalStorage() {
    this.levelStates = new Map<string, ILevelState>();
    for (const level of globalLevelsList) {
      const metadata = JSON.parse(
        localStorage.getItem('level-' + level.internalName + '-meta')
        || '{"savedVersion": 1, "everBeaten": false, "everOpened": false}'
      );
      const code = localStorage.getItem('level-' + level.internalName + '-saved-code') || level.startingCode;
      this.levelStates.set(level.internalName, { metadata, code });
    }
  }

  reportError(lineNum: number, message: string) {
    const lineOfCode = this.state.code.split('\n')[lineNum - 1];
    this.setState({
      terminalOutput: `  ${lineOfCode}\n\nError on line ${lineNum}: ${message}`,
    });
  }

  simulate(components: EComponent[]) {
    // Insert components for power and ground.
    components = [
      ...components,
      {kind: 'signal', net: 'vdd', pattern: ['1'], repeat: false},
      {kind: 'signal', net: 'gnd', pattern: ['0'], repeat: false},
    ];
    // Find all nets.
    const nets = new Set<string>(['vdd', 'gnd']);
    const probes: EProbe[] = [];
    const netCanonicalizer = new UnionFind<string>();
    for (const component of components) {
      switch (component.kind) {
        case 'fet':
          for (const net of [component.gate, component.drain, component.source])
            nets.add(net);
          break;
        case 'wire':
          for (const net of component.nets)
            nets.add(net);
          netCanonicalizer.union(...component.nets);
          break;
        case 'probe':
          probes.push(component);
          nets.add(component.net);
          break;
        case 'pull_resistor':
        case 'button':
        case 'signal':
          nets.add(component.net);
          break;
      }
    }

    // TODO: Possibly run DRCs here, like checking that it's valid CMOS.

    if (!wasmInitialized) {
      this.setState({ simOutput: 'Wasm component not initialized.' });
      return;
    }

    // Serialize the results.
    const descArray: number[] = [];
    const netIndices = new Map<string, number>();
    for (const net of nets) {
      const canonicalizedNet = netCanonicalizer.canonicalize(net);
      if (!netIndices.has(canonicalizedNet)) {
        netIndices.set(canonicalizedNet, netIndices.size);
      }
      netIndices.set(net, netIndices.get(canonicalizedNet)!);
    }
    for (const component of components) {
      switch (component.kind) {
        case 'fet':
          descArray.push(
            1,
            +component.isPfet,
            netIndices.get(component.gate)!,
            netIndices.get(component.drain)!,
            netIndices.get(component.source)!,
          );
          break;
        case 'signal':
          descArray.push(
            2,
            netIndices.get(component.net)!,
            +component.repeat,
            component.pattern.length,
            ...[...component.pattern].map((c) => ({'0': 0, '1': 1, 'z': 2}[c])),
          );
          break;
        case 'pull_resistor':
          descArray.push(
            3,
            {'up': 0, 'down': 1}[component.direction],
            netIndices.get(component.net)!,
          );
          break;
        default:
          continue;
      }
      descArray.push(123456789);
    }
    const desc = new Uint32Array(descArray);
    const traceValues = perform_simulation(desc, netIndices.size, 400, 10);
    const traceIndices = get_indices();
    const traces: Uint8Array[] = [];
    let shootThroughOccurred = false;
    let earliestShootThrough = Infinity;
    for (let i = 0; i < traceIndices.length; i += 2) {
      const start = traceIndices[i];
      const len = traceIndices[i + 1];
      const trace = traceValues.slice(start, start + len);
      let t = 0;
      for (const v of trace) {
        if (v == 3) {
          shootThroughOccurred = true;
          earliestShootThrough = Math.min(earliestShootThrough, t);
        }
        t++;
      }
      traces.push(trace);
    }

    const netTraces = new Map<string, Uint8Array>();
    for (const net of nets)
      netTraces.set(net, traces[netIndices.get(net)!]);

    let simOutput = `Components: ${components.length - 2}  Nets: ${nets.size}`;
    const simResults: ISimResults = {
      components: components.length,
      nets: [...nets],
      netTraces,
      probes,
      shootThroughOccurred,
      earliestShootThrough,
    };

    const grading: IGrading = shootThroughOccurred ?
      {
        success: false,
        failureTime: earliestShootThrough,
        message: 'Shoot through (shorting vdd to gnd) is never allowed.',
        miniMessage: 'Shoot through occurs here',
      }
      : this.state.currentLevel.gradeResults(simResults);

    if (grading.success) {
      const levelState = this.levelStates.get(this.state.currentLevel.internalName)!;
      levelState.metadata.everBeaten = true;
      persistLevelState(this.state.currentLevel.internalName, levelState);
    } else {
      simOutput += '\n\nLEVEL FAILED: ' + grading.message;
    }

    this.setState({ simOutput, simResults, grading });
  }

  onCompile = (code: string) => {
    const Sk = (window as any).Sk;
    Sk.pre = "output";
    var results: string[] = [];

    const components: EComponent[] = [];

    var nextId = 0;
    function getId(): string {
      nextId++;
      return nextId.toString();
    }

    Sk.builtins.vdd = Sk.ffi.remapToPy('vdd');
    Sk.builtins.gnd = Sk.ffi.remapToPy('gnd');

    Sk.builtins.new_net = (name: any) => {
      return Sk.ffi.remapToJs(name) + getId();
    };
    Sk.builtins.new_net.co_varnames = ['name'];
    Sk.builtins.new_net.$defaults = ['net'];
    Sk.builtins.new_net.co_numargs = 1;

    Sk.builtins.nfet = (gate: any, drain: any, source: any) => {
      if (gate === undefined || drain === undefined)
        throw 'nfet must be called like nfet(gate, drain, source) or like nfet(gate, drain) with source implicitly being gnd';
      gate = Sk.ffi.remapToJs(gate);
      drain = Sk.ffi.remapToJs(drain);
      source = Sk.ffi.remapToJs(source);
      if (source === undefined)
        source = 'gnd';
      if (typeof gate !== 'string') throw 'nfet(gate, drain, source) gate argument must be net';
      if (typeof drain !== 'string') throw 'nfet(gate, drain, source) drain argument must be net';
      if (typeof source !== 'string') throw 'nfet(gate, drain, source) source argument must be net';
      components.push({ kind: 'fet', isPfet: false, gate, drain, source });
    };
    Sk.builtins.nfet.co_varnames = ['gate', 'drain', 'source'];
    Sk.builtins.nfet.$defaults = [undefined, undefined, undefined];
    Sk.builtins.nfet.co_numargs = 3;

    Sk.builtins.pfet = (gate: any, drain: any, source: any) => {
      if (gate === undefined || drain === undefined)
        throw 'pfet must be called like pfet(gate, drain, source) or like pfet(gate, drain) with source implicitly being vdd';
      gate = Sk.ffi.remapToJs(gate);
      drain = Sk.ffi.remapToJs(drain);
      source = Sk.ffi.remapToJs(source);
      if (source === undefined)
        source = 'vdd';
      if (typeof gate !== 'string') throw 'pfet(gate, drain, source) gate argument must be net';
      if (typeof drain !== 'string') throw 'pfet(gate, drain, source) drain argument must be net';
      if (typeof source !== 'string') throw 'pfet(gate, drain, source) source argument must be net';
      components.push({ kind: 'fet', isPfet: true, gate, drain, source });
    };
    Sk.builtins.pfet.co_varnames = ['gate', 'drain', 'source'];
    Sk.builtins.pfet.$defaults = [undefined, undefined, undefined];
    Sk.builtins.pfet.co_numargs = 3;

    Sk.builtins.probe = (label: string, net: any) => {
      label = Sk.ffi.remapToJs(label);
      net = Sk.ffi.remapToJs(net);
      if (typeof label !== 'string') throw 'probe(label, net) label argument must be string';
      if (typeof net !== 'string') throw 'probe(label, net) net argument must be string';
      components.push({ kind: 'probe', label, net });
    };
    Sk.builtins.probe.co_varnames = ['label', 'net'];
    Sk.builtins.probe.co_numargs = 2;

    Sk.builtins.pull_down_resistor = (net: any) => {
      net = Sk.ffi.remapToJs(net);
      if (typeof net !== 'string') throw 'pull_down_resistor(net) net argument must be string';
      components.push({ kind: 'pull_resistor', direction: 'down', net });
    };
    Sk.builtins.pull_down_resistor.co_varnames = ['net'];
    Sk.builtins.pull_down_resistor.co_numargs = 1;

    Sk.builtins.pull_up_resistor = (net: any) => {
      net = Sk.ffi.remapToJs(net);
      if (typeof net !== 'string') throw 'pull_up_resistor(net) net argument must be string';
      components.push({ kind: 'pull_resistor', direction: 'up', net });
    };
    Sk.builtins.pull_up_resistor.co_varnames = ['net'];
    Sk.builtins.pull_up_resistor.co_numargs = 1;

    Sk.builtins.wire_together = (net1: any, net2: any) => {
      net1 = Sk.ffi.remapToJs(net1);
      net2 = Sk.ffi.remapToJs(net2);
      if (typeof net1 !== 'string') throw 'wire_together(net1, net2) net1 argument must be string';
      if (typeof net2 !== 'string') throw 'wire_together(net1, net2) net2 argument must be string';
      components.push({ kind: 'wire', nets: [net1, net2] });
    };
    Sk.builtins.wire_together.co_varnames = ['net1', 'net2'];
    Sk.builtins.wire_together.co_numargs = 2;

    /*
    Sk.builtins.button = () => {
      const net = 'button' + getId();
      components.push({ kind: 'button', net });
      return Sk.ffi.remapToPy(net);
    };
    Sk.builtins.button.co_varnames = [];
    Sk.builtins.button.co_numargs = 0;
    */

    Sk.builtins.signal = (pattern: any, name: any) => {
      const net = Sk.ffi.remapToJs(name) + getId();
      if (pattern === undefined)
        throw 'signal must take pattern, like: signal("01...")';
      pattern = Sk.ffi.remapToJs(pattern).toLowerCase();
      const repeat = pattern.endsWith('...');
      if (repeat)
        pattern = pattern.slice(0, -3);
      for (const c of pattern)
        if (c !== '0' && c !== '1' && c !== 'z')
          throw 'The pattern must be made of 0s, 1s and zs, and may optionally end with ... to indicate that the pattern should repeat.';
      components.push({ kind: 'signal', net, pattern, repeat });
      return Sk.ffi.remapToPy(net);
    };
    Sk.builtins.signal.co_varnames = ['desc', 'name'];
    Sk.builtins.signal.$defaults = [undefined, 'signal'];
    Sk.builtins.signal.co_numargs = 2;

    Sk.builtins.get_level_inputs = () => {
      const nets = this.state.currentLevel.makeInputNets(components);
      return Sk.ffi.remapToPy(nets);
    };
    Sk.builtins.get_level_inputs.co_varnames = [];
    Sk.builtins.get_level_inputs.co_numargs = 0;

    Sk.builtins.get_level_outputs = () => {
      const nets = this.state.currentLevel.makeOutputNets(components);
      return Sk.ffi.remapToPy(nets);
    };
    Sk.builtins.get_level_outputs.co_varnames = [];
    Sk.builtins.get_level_outputs.co_numargs = 0;

    Sk.configure({
      output: (obj: any) => {
        results.push(obj.toString());
        //console.log('Printing:', obj.toString());
      },
      read: builtinRead,
    });
    //(Sk.TurtleGraphics || (Sk.TurtleGraphics = {})).target = 'mycanvas';
    var myPromise = Sk.misceval.asyncToPromise(function () {
      return Sk.importMainWithBody("<stdin>", false, code, true);
    });
    myPromise.then(
      (mod: any) => {
        //console.log('success');
        this.setState({ terminalOutput: `Success: components=${components.length}\n` + results.join('') });
        this.simulate(components);
      },
      (err: any) => {
        this.setState({ terminalOutput: results.join('') + '\n' + err.toString() });
      },
    );
  }

  switchToLevel(level: ILevel) {
    this.setState({
      page: 'level',
      currentLevel: level,
      code: this.levelStates.get(level.internalName)!.code,
      terminalOutput: '(Hit ctrl + enter in the code window to rerun.)',
      simOutput: '',
      simResults: null,
    });

    const levelState = this.levelStates.get(level.internalName)!;
    levelState.metadata.everOpened = true;
    persistLevelState(level.internalName, levelState);

    window.history.pushState({page: 'level', currentLevel: level.internalName}, 'Make a Microprocessor');
  }

  render() {
    if (this.state.page === 'level-select') {
      var locked = false;

      return <div style={{
        width: '100%',
        height: '100vh',
        color: 'white',
        fontFamily: 'monospace',
        display: 'flex',
        justifyContent: 'center',
        textAlign: 'center',
        fontSize: '150%',
      }}>
        <div style={{
          marginTop: 30,
        }}>
          <span style={{fontSize: '200%'}}>Make a Processor</span><br/>
          <br/>
          Select a level:
          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 20 }}>
            {globalLevelsList.map((level, i) => {
              const levelState = this.levelStates.get(level.internalName)!;

              const result = <div
                key={i}
                style={{
                  fontSize: '150%',
                  margin: 10,
                  padding: 10,
                  width: 300,
                  position: 'relative',
                }}
                className={locked ? 'lockedButton' : 'hoverButton'}
                onClick={locked ? () => null : () => this.switchToLevel(level)}
              >
                {locked ? '???' : level.name}
                {!locked && !levelState.metadata.everOpened && <div style={{
                  position: 'absolute',
                  fontSize: '80%',
                  color: 'red',
                  left: '92%',
                  top: '0%',
                  transform: 'rotate(30deg)',
                }}>
                  New!
                </div>}
                {levelState.metadata.everBeaten && <div style={{
                  position: 'absolute',
                  fontSize: '300%',
                  color: 'green',
                  left: '100%',
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                }}>
                  ✓
                </div>}
              </div>;

              if (!levelState.metadata.everBeaten)
                locked = true;

              return result;
            })}
          </div>
        </div>

        <div style={{ position: 'absolute', left: 10, bottom: 10 }}>
          By Peter Schmidt-Nielsen
        </div>
        <div
          style={{ position: 'absolute', right: 10, bottom: 10, padding: 10 }}
          className='hoverButton'
          onClick={() => {
            if (window.confirm('Are you sure you want to completely reset the game state, including throwing away all of your code?')) {
              resetGameState();
              this.loadLevelStatesFromLocalStorage();
              this.forceUpdate();
            }
          }}
        >
          Reset Entire Game State
        </div>
      </div>;
    }

    const codeMirrorOptions = (onCompile: (code: string) => void) => ({
      mode: 'python',
      theme: 'material',
      lineNumbers: true,
      indentUnit: 4,
      lineWrapping: true,
      extraKeys: {
        'Ctrl-Enter': (cm: any) => {
          onCompile(this.state.code);
        },
        'Ctrl-S': (cm: any) => {
          const levelState = this.levelStates.get(this.state.currentLevel.internalName)!;
          levelState.code = this.state.code;
          persistLevelState(this.state.currentLevel.internalName, levelState);
          this.forceUpdate();
        },
        /*'Tab': (cm: any) => {
          cm.replaceSelection('  ', 'end');
        },*/
      },
    });
    const vertResizeStyle = {
      background: 'black',
      width: '3px',
      cursor: 'col-resize',
      height: '100%',
    };
    const horizResizeStyle = {
      background: 'black',
      height: '3px',
      cursor: 'row-resize',
      width: '100%',
    };
    let vertSplitDefault = parseInt(localStorage.getItem('split1') || '500');
    let horizSplitDefault = parseInt(localStorage.getItem('split2') || '400');
    return <div style={{
      display: 'flex',
    }}>
      {/* Code editor */}
      <SplitPane
        split="vertical"
        minSize={300}
        defaultSize={vertSplitDefault}
        onChange={(size) => localStorage.setItem('split1', size.toString())}
        resizerStyle={vertResizeStyle}
      >
        <div style={{ position: 'relative' }}>
          <ControlledCodeMirror
            value={this.state.code}
            options={codeMirrorOptions(this.onCompile)}
            onBeforeChange={(editor, data, code) => {
              this.setState({ code });
            }}
          />
          {this.state.code !== this.levelStates.get(this.state.currentLevel.internalName)!.code &&
            <div style={{
              position: 'absolute',
              right: '5%',
              bottom: '5%',
              userSelect: 'none',
              zIndex: 5,
              color: 'red',
              opacity: 0.5,
            }}>
                ⬤ Unsaved
            </div>
          }
        </div>

        <div>
          <SplitPane
            split="horizontal"
            minSize={30}
            defaultSize={horizSplitDefault}
            onChange={(size) => localStorage.setItem('split2', size.toString())}
            resizerStyle={horizResizeStyle}
          >
            <div style={{
              width: '100%',
              height: '100%',
              backgroundColor: '#333',
              color: 'white',
              fontFamily: 'monospace',
            }}>
              <div style={{ margin: 10 }}>
                {/*
                {this.state.simResults !== null && <>
                  <Collapsible trigger='Nets' transitionTime={100}>
                    {[...this.state.simResults.nets].map((net: any) =>
                      <div key={net}>
                        {net}: 1234
                      </div>
                    )}
                  </Collapsible>
                </>}
                */}

                {this.state.simResults !== null &&
                  /*
                  this.state.simResults.probes.map((probeName) =>
                    <div key={probeName} style={{display: 'flex', justifyContent: 'center', alignContent: 'center', alignItems: 'center'}}>
                      <div>{probeName}:</div>
                      {renderTrace(this.state.simResults!.netTraces.get(probeName)!)}
                    </div>
                  )*/
                  renderTraces(this.state.simResults, this.state.grading!)
                }
              </div>
            </div>

            <div style={{
              backgroundColor: '#222',
              color: 'white',
              fontFamily: 'monospace',
              width: '100%',
              height: '100%',
              display: 'flex',
            }}>
              <div style={{ margin: 10, width: 400 }}>
                <b>{this.state.currentLevel.name}</b>
                <p style={{whiteSpace: 'pre-wrap'}}>
                  {this.state.currentLevel.levelDesc}
                </p>
              </div>
              <div
                style={{ width: 2, backgroundColor: '#555' }}
              />
              <div style={{
                margin: 10,
                whiteSpace: 'pre-wrap',
                color: 'white',
              }}>
                {this.state.terminalOutput}
                <span style={{color: 'red'}}>{'\n\n' + this.state.simOutput}</span>
              </div>
            </div>
          </SplitPane>
        </div>
      </SplitPane>

      {/* Menu bar */}
      <div style={{
        width: 100,
      }}>
        asdf
      </div>
    </div>;
  }
}

export default App;
