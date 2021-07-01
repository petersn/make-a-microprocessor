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
            <text x={shootThroughStart + 55} y={20} textAnchor='middle' stroke='red' fill='red'>Shoot through!</text>
          </>
        }
      </g>
    );
    probeIndex++;
  }

  const errorX = 143 + xStep * grading.failureTime;

  const gridLines = [];
  for (let t = 11; t < 400; t += 10) {
    gridLines.push(
      <path
        d={`M ${143 + xStep * t} 0 l 0 ${height - 30}`}
        stroke='rgba(255, 255, 255, 0.2)'
        strokeWidth={2}
        fill='transparent'
      />
    );
  }

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
    {gridLines}
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
      if (value == -1)
        continue;
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

function reqSeq(s: string): [number, number][] {
  const result: [number, number][] = [];
  let t = 8;
  for (const c of s) {
    if (c === 'z')
      result.push([t, 0]);
    else if (c === '0')
      result.push([t, 1]);
    else if (c === '1')
      result.push([t, 2]);
    else if (c === 'x')
      result.push([t, -1]);
    t += 10;
  }
  return result;
}

const globalLevelsList: ILevel[] = [
  // ============================== FETs ==============================
  {
    internalName: 'fets',
    name: 'FETs',
    levelDesc: `Welcome to make-a-microprocessor, where you use FETs to solve a series of puzzles.

Write your "Python" program in the left pane, calling functions to make electrical components. Run your program by hitting ctrl + enter in the code pane.

To get a list of electrical components and code to construct them click on the "Parts List" button in the top left.

Your goal in this first level is to use two FETs to drive the \`not_A\` net to be high when \`A\` is low, and vice versa (an inverter/not gate).`,
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
      { net: '_net_not_A', netName: '¬A', reqs: reqSeq('1010') },
    ]),
  },

  // ============================== High-Z Output ==============================
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

# Hint: You can create your own signals for testing purposes.
test_signal = signal("001z10...")
probe("Test signal", test_signal)

# You might also want to check out new_net() and wire_together(net1, net2) in the Parts List.
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
      { net: '_net_not_A', netName: '¬A', reqs: reqSeq('zzzz101z') },
    ]),
  },

  // ============================== Logic Gates ==============================
  {
    internalName: 'logic_gates',
    name: 'Logic Gates',
    levelDesc: `We will now create logic gates. Implement each of the listed gate functions.

These definitions will be extremely useful, so you may wish to copy some or all of them to later levels as well.

All your logic gate implementations must drive their output even if an input is undriven (high Z) so long as the other input(s) are sufficient to determine the output. For example, your AND implementation must drive the output low if one input is low and the other is undriven.

Do not worry if your gate implementations produce garbage outputs for a small amount of time after their inputs switch. This is a normal part of combinational logic, and is known as the propagation delay. Some nomenclature:

  Propagation delay: Max time from an input change to output stabilizing.
  Contamination delay: Min time from an input change to output change.`,
    startingCode: `
def not_gate(x):
    r = new_net()
    ...
    return r

def nand_gate(x, y):
    r = new_net()
    ...
    return r

def and_gate(x, y):
    r = new_net()
    ...
    return r

def or_gate(x, y):
    r = new_net()
    ...
    return r

def xor_gate(x, y):
    r = new_net()
    ...
    return r

def mux_gate(select, x, y):
    r = new_net()
    ...
    return r

A, B, C = get_level_inputs()
not_out, nand_out, and_out, or_out, xor_out, mux_out = get_level_outputs()

probe("A", A)
probe("B", B)
probe("C", C)
probe("¬A", not_out)
probe("¬(A ∧ B)", nand_out)
probe("A ∧ B", and_out)
probe("A ∨ B", or_out)
probe("A ⊕ B", xor_out)
probe("mux(C, A, B)", mux_out)

wire_together(not_gate(A), not_out)
wire_together(nand_gate(A, B), nand_out)
wire_together(and_gate(A, B), and_out)
wire_together(or_gate(A, B), or_out)
wire_together(xor_gate(A, B), xor_out)
wire_together(mux_gate(C, A, B), mux_out)
`,
    makeInputNets: (components: EComponent[]) => {
      components.push(
        { kind: 'signal', net: '_net_A', pattern: [...'01010101zz01z'] as any, repeat: false },
        { kind: 'signal', net: '_net_B', pattern: [...'0011001101zzz'] as any, repeat: false },
        { kind: 'signal', net: '_net_C', pattern: [...'000011110000z'] as any, repeat: false },
      );
      return ['_net_A', '_net_B', '_net_C'];
    },
    makeOutputNets: () => ['_net_not_out', '_net_nand_out', '_net_and_out', '_net_or_out', '_net_xor_out', '_net_mux_out'],
    gradeResults: (simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_not_out',  netName: '¬A',           reqs: reqSeq('10101010zz10z') },
      { net: '_net_nand_out', netName: '¬(A ∧ B)',     reqs: reqSeq('111011101z1zz') },
      { net: '_net_and_out',  netName: 'A ∧ B',        reqs: reqSeq('000100010z0zz') },
      { net: '_net_or_out',   netName: 'A ∨ B',        reqs: reqSeq('01110111z1z1z') },
      { net: '_net_xor_out',  netName: 'A ⊕ B',        reqs: reqSeq('01100110zzzzz') },
      { net: '_net_mux_out',  netName: 'mux(C, A, B)', reqs: reqSeq('01010011zz01z') },
    ]),
  },

  // ============================== Adder ==============================
  {
    internalName: 'adder',
    name: 'Adder',
    levelDesc: `Your goal is to implement a 3-bit + 3-bit to 3-bit two's complement adder (throwing away the carry bit). The numbers are all little-endian, and thus the first bit in a list is the lowest order.`,
    startingCode: `
def adder(a: "List[Net]", b: "List[Net]") -> "List[Net]":
    assert len(a) == len(b)
    result = [new_net() for _ in range(len(a))]
    # Inputs are little endian: a[0] is the lowest order bit.
    ...
    return result

A_nets, B_nets = get_level_inputs()
output_nets = get_level_outputs()

for i, n in enumerate(A_nets):
    probe("A[%i]" % i, n)
for i, n in enumerate(B_nets):
    probe("B[%i]" % i, n)
for i, n in enumerate(output_nets):
    probe("(A + B)[%i]" % i, n)

# Use our adder function, then wire it up to the outputs.
result = adder(A_nets, B_nets)
for n1, n2 in zip(output_nets, result):
    wire_together(n1, n2)
`,
    makeInputNets: (components: EComponent[]) => {
      components.push(
        { kind: 'signal', net: '_net_A0', pattern: [...'000111111111z'] as any, repeat: false },
        { kind: 'signal', net: '_net_A1', pattern: [...'000000000111z'] as any, repeat: false },
        { kind: 'signal', net: '_net_A2', pattern: [...'000000000000z'] as any, repeat: false },
        { kind: 'signal', net: '_net_B0', pattern: [...'000000111111z'] as any, repeat: false },
        { kind: 'signal', net: '_net_B1', pattern: [...'000000000000z'] as any, repeat: false },
        { kind: 'signal', net: '_net_B2', pattern: [...'000000000111z'] as any, repeat: false },
      );
      return [['_net_A0', '_net_A1', '_net_A2'], ['_net_B0', '_net_B1', '_net_B2']];
    },
    makeOutputNets: () => ['_net_sum0', '_net_sum1', '_net_sum2'],
    gradeResults: (simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_sum0', netName: '(A + B)[0]', reqs: reqSeq('xx0xx1xx0xx0') },
      { net: '_net_sum1', netName: '(A + B)[1]', reqs: reqSeq('xx0xx0xx1xx0') },
      { net: '_net_sum2', netName: '(A + B)[2]', reqs: reqSeq('xx0xx0xx0xx0') },
    ]),
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
  paneColor: string;
  docsOpen: boolean;
  cheatMode: boolean;
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
      paneColor: '#222',
      docsOpen: false,
      cheatMode: false,
    };

    window.onpopstate = (event) => {
      this.navigateBack();
    };

    var cheat_index = 0;
    const cheat_sequence = 'unlock';
    document.addEventListener('keydown', (evt) => {
      if (evt.key === cheat_sequence[cheat_index]) {
        cheat_index++;
        if (cheat_index >= cheat_sequence.length)
          this.setState({cheatMode: true });
      } else {
        cheat_index = 0; 
      }
    });
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
    const startTime = performance.now();
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

    const elapsed = performance.now() - startTime;
    let simOutput = `------- Simulation completed in: ${elapsed}ms (Components: ${components.length - 2} Nets: ${nets.size})`;
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
      this.setState({ paneColor: '#343' });
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
        let terminalOutput = results.join('');
        if (terminalOutput && !terminalOutput.endsWith('\n'))
          terminalOutput += '\n';
        this.setState({ terminalOutput, paneColor: '#222' });
        this.simulate(components);
      },
      (err: any) => {
        this.setState({ terminalOutput: results.join('') + '\n' + err.toString(), simOutput: '', paneColor: '#433' });
      },
    );
  }

  switchToLevel(level: ILevel) {
    this.setState({
      page: 'level',
      currentLevel: level,
      code: this.levelStates.get(level.internalName)!.code,
      terminalOutput: '',
      simOutput: '(Hit ctrl + enter in the code window to rerun.)',
      simResults: null,
      grading: null,
      paneColor: '#222',
    });

    const levelState = this.levelStates.get(level.internalName)!;
    levelState.metadata.everOpened = true;
    persistLevelState(level.internalName, levelState);

    window.history.pushState({page: 'level', currentLevel: level.internalName}, 'Make a Microprocessor');
  }

  getIsUnsaved(): boolean {
    return this.state.code !== this.levelStates.get(this.state.currentLevel.internalName)!.code;
  }

  navigateBack() {
    if (!this.getIsUnsaved() || window.confirm('Exit level without saving work? (Just hit ctrl+s in the code editor.)'))
      this.setState({ page: 'level-select' });
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
          <span style={{fontSize: '200%'}}>Make a Microprocessor</span><br/>
          <br/>
          Select a level:<br/>
          <div style={{ display: 'inline-block' }}>
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 20 }}>
              {globalLevelsList.map((level, i) => {
                const levelState = this.levelStates.get(level.internalName)!;

                const result = <div
                  key={i}
                  style={{
                    fontSize: '120%',
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

                if (!levelState.metadata.everBeaten && !this.state.cheatMode)
                  locked = true;

                return result;
              })}
            </div>
          </div>
        </div>

        <div style={{ position: 'absolute', left: 10, bottom: 10 }}>
          By Peter Schmidt-Nielsen (v0.2b)
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
      minWidth: '3px',
      cursor: 'col-resize',
      height: '100%',
      zIndex: 20,
    };
    const horizResizeStyle = {
      background: 'black',
      height: '3px',
      minHeight: '3px',
      cursor: 'row-resize',
      width: '100%',
      zIndex: 20,
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
          {/* Top left menu bar */}
          <div style={{ display: 'flex', alignItems: 'center', background: '#444', borderBottom: '2px solid #222' }}>
            <div
              style={{
                bottom: 10,
                right: 70,
              }}
              className='mainButton'
              onClick={() => this.navigateBack()}
            >
              ❮
            </div>
            <div
              style={{
                bottom: 10,
                right: 10,
              }}
              className='mainButton'
              onClick={() => this.setState({ docsOpen: !this.state.docsOpen })}
            >
              Parts List
            </div>
            <div
              style={{
                bottom: 10,
                right: 10,
              }}
              className='mainButton'
              onClick={() => {
                if (window.confirm("Throw away your code and reset to the level's starting code?"))
                  this.setState({ code: this.state.currentLevel.startingCode});
              }}
            >
              Reset code
            </div>
            {/*
            <div style={{ color: 'white', marginLeft: 10, fontSize: '150%' }}>
              Level: {this.state.currentLevel.name}
            </div>
            */}
          </div>

          <ControlledCodeMirror
            value={this.state.code}
            options={codeMirrorOptions(this.onCompile)}
            onBeforeChange={(editor, data, code) => {
              this.setState({ code });
            }}
          />
          {this.getIsUnsaved() &&
            <div style={{
              position: 'absolute',
              right: 20,
              bottom: 20,
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
              backgroundColor: this.state.paneColor,
              color: 'white',
              fontFamily: 'monospace',
              width: '100%',
              height: '100%',
              display: 'flex',
            }}>
              <div style={{ padding: 10, width: 400, backgroundColor: '#222' }}>
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
                {this.state.terminalOutput && <>
                  Python output:<br/>
                  <span style={{color: 'lightblue'}}>{this.state.terminalOutput}</span><br/>
                  <br/>
                </>}
                {this.state.simOutput}
              </div>
            </div>
          </SplitPane>
        </div>
      </SplitPane>

      {this.state.paneColor === '#343' && <div style={{
        position: 'absolute',
        right: 30,
        bottom: 30,
        padding: 20,
        fontSize: '400%',
        boxShadow: '0px 0px 50px green',
      }} className='hoverButton' onClick={() => {
        this.navigateBack();
      }}>
        You win!
      </div>}

      <div style={{
        position: 'absolute',
        width: 800,
        height: '100%',
        boxSizing: 'border-box',
        boxShadow: '0px 0px 10px black',
        right: this.state.docsOpen ? 810 : 0,
        zIndex: 100,
        backgroundColor: '#666',
        transition: '0.2s right',
        padding: 10,
        transform: 'translate(810px, 0px)',
        overflowY: 'scroll',
      }}>
        <div style={{ position: 'sticky', top: 0 }}>
          <div
            style={{ position: 'absolute', top: 5, right: 5, fontSize: '120%', padding: 4 }}
            className='hoverButton'
            onClick={() => this.setState({ docsOpen: false })}
          >
            ✕
          </div>
        </div>

        <span style={{ fontSize: '150%', fontWeight: 'bold' }}>Parts list</span>
        <p>
          The code area is "Python".
          I provide functions that construct circuit components as a side effect.
          The four functions you need to use to assemble your circuit are:

          <div style={{ marginLeft: 20, marginBottom: 20 }}>
            <pre style={{ fontWeight: 'bold', fontSize: '120%' }}>nfet(gate: Net, drain: Net, source: Optional[Net])</pre>
            <div style={{ marginLeft: 20 }}>
              Constructs an n-channel FET in the circuit. The behavior is:
              <pre style={{ marginLeft: 20 }}>{
`if gate is high and source is low:
    drive drain low`
              }</pre>
              If the source argument is omitted it defaults to <code>gnd</code> (always low).
              Examples:
              <pre style={{ marginLeft: 20 }}>{
`# Pulls \`output\` down whenever \`gate\` is high.
nfet(gate, output, gnd)

# This is equivalent to the above, as gnd is implicit.
nfet(gate, output)

# Here two nfets are wired in series. Thus, \`output\` is
# pulled down when both \`gate1\` and \`gate2\` are high.
intermediate = new_net()
nfet(gate1, intermediate)
nfet(gate2, output, intermediate)`
              }</pre>

              There is no modeled body diode, so the FET simply does nothing (doesn't conduct) if source is high and drain is low.
              Additionally, no gate capacitance is modeled — all nets that aren't driven return to a floating state which doesn't switch FETs on.
            </div>

            <pre style={{ fontWeight: 'bold', fontSize: '120%' }}>pfet(gate: Net, drain: Net, source: Optional[Net])</pre>
            <div style={{ marginLeft: 20 }}>
              Constructs a p-channel FET in the circuit. The behavior is:
              <pre style={{ marginLeft: 20 }}>{
`if gate is low and source is high:
    drive drain high`
              }</pre>
              If the source argument is omitted it defaults to <code>vdd</code> (always high).
              Again, there is no modeled body diode or gate capacitance.
            </div>

            <pre style={{ fontWeight: 'bold', fontSize: '120%' }}>new_net() -&gt; Net</pre>
            <div style={{ marginLeft: 20 }}>
              Creates a new unique net (electrical node in your circuit), and returns it.
            </div>

            <pre style={{ fontWeight: 'bold', fontSize: '120%' }}>wire_together(net1: Net, net2: Net)</pre>
            <div style={{ marginLeft: 20 }}>
              Connect two nets together so that they are electrically equivalent.
            </div>
          </div>

          I provide two additional functions for debugging and testing purposes:

          <div style={{ marginLeft: 20, marginBottom: 20 }}>
            <pre style={{ fontWeight: 'bold', fontSize: '120%' }}>probe(label: str, net: Net)</pre>
            <div style={{ marginLeft: 20 }}>
              Causes a net's voltage to be plotted in the simulation results pane (top right).
            </div>

            <pre style={{ fontWeight: 'bold', fontSize: '120%' }}>signal(pattern: str) -&gt; Net</pre>
            <div style={{ marginLeft: 20 }}>
              Constructs a signal generator component, and returns the generator's output net.
              The pattern string must be made of 0s, 1s, and zs, and may optionally end with ... to indicate that the pattern should repeat.
              The value z indicates that the signal generator shouldn't drive the output (high Z).

              Examples:
              <pre style={{ marginLeft: 20 }}>{
`# Creates a clock signal that toggles every time step.
clock = signal('01...')

# The signal waits three time steps, then drives high,
# then stops driving forever.
output = signal('zzz1z')`
              }</pre>
            </div>
          </div>
        </p>
      </div>
    </div>;
  }
}

export default App;
