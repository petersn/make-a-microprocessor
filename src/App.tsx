import React from 'react';
import './App.css';
import { Controlled as ControlledCodeMirror } from 'react-codemirror2';
import 'codemirror/lib/codemirror.css';
import 'codemirror/theme/material.css';
import 'codemirror/mode/python/python';
import RawCodeMirror from 'codemirror';
import SplitPane from 'react-split-pane';

import init, {
  get_indices,
  perform_simulation,
  init_panic_hook,
  get_first_shoot_through,
} from './wasm-build/libsnpspice.js';

let wasmInitialized = false;
let wasm = init(process.env.PUBLIC_URL + "/libsnpspice_bg.wasm").then(() => {
  wasmInitialized = true;
  init_panic_hook();
});

interface EFet {
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

interface ETrace {
  kind: 'trace';
  nets: string[];
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

interface ESram {
  kind: 'sram';
  contents: Uint32Array;
  address_nets: string[];
  bus_in_nets: string[];
  bus_out_nets: string[];
  write_enable_net: string;
}

type EComponent = (
  EFet |
  EPullResistor |
  EProbe |
  ETrace |
  EWire |
  EButton |
  ESignal |
  ESram
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

function renderTraces(level: ILevel, simResults: ISimResults, grading: IGrading) {
  const width = 800;
  const height = 30 * (simResults.probes.length + 1);

  const svgContents = [];

  let probeIndex = 0;
  //const xStep = 5;

  for (const probe of simResults.probes) {
    const forwardPass: string[] = [];
    const backwardPass: string[] = [];
    let i = 0;
    let shootThroughStart = -1;
    const trace = simResults.netTraces.get(probe.net)!;
    for (const traceVal of trace) {
      const x = 3 + i * level.xStep;
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
          strokeWidth={ level.xStep >= 5 ? 3 : (level.xStep >= 4 ? 2 : 1.5) }
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

  const errorX = 143 + level.xStep * grading.failureTime;

  const gridLines = [];
  for (let t = 1 + level.clockDivider; t < level.simSteps; t += level.clockDivider * level.tickSpacing) {
    gridLines.push(
      <path
        d={`M ${143 + level.xStep * t} 0 l 0 ${height - 30}`}
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
  gradeResults: (self: ILevel, simResults: ISimResults) => IGrading;
  xStep: number;
  simSteps: number;
  clockDivider: number;
  tickSpacing: number;
}

function doGrading(
  simResults: ISimResults,
  tracesToGrade: { net: string, netName: string, reqs: [number, number][], failureMessages?: string[] }[],
): IGrading {
  for (const { net, netName, reqs, failureMessages } of tracesToGrade) {
    const trace = simResults.netTraces.get(net)!;
    if (trace === undefined) {
      return {
        success: false,
        failureTime: 0,
        message: 'Signal ' + netName + ' is undefined. Are you calling get_level_outputs?',
        miniMessage: 'Signal ' + netName + ' undefined',
      };
    }
    for (const [time, value] of reqs) {
      if (value == -1)
        continue;
      if (trace[time] !== value) {
        const mapping = {0: 'undriven', 1: 'low', 2: 'high'} as any;
        const got = mapping[trace[time]];
        const wanted = mapping[value];
        let message = `${netName} is ${got}, but should have been ${wanted}.`;
        let miniMessage = `${netName} should be ${wanted}`;
        if (failureMessages !== undefined)
          [message, miniMessage] = failureMessages;
        return { success: false, failureTime: time, message, miniMessage };
      }
    }
  }
  return { success: true, failureTime: 0, message: 'All tests passed!', miniMessage: '' };
}

function reqSeq(clockDivider: number, s: string): [number, number][] {
  const result: [number, number][] = [];
  let t = Math.round(clockDivider * 0.8);
  for (const c of s) {
    if (c === 'z')
      result.push([t, 0]);
    else if (c === '0')
      result.push([t, 1]);
    else if (c === '1')
      result.push([t, 2]);
    else if (c === 'x')
      result.push([t, -1]);
    t += clockDivider;
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
probe("??A", not_A)

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
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_not_A', netName: '??A', reqs: reqSeq(self.clockDivider, '1010') },
    ]),
    xStep: 5,
    simSteps: 400,
    clockDivider: 10,
    tickSpacing: 1,
  },

  // ============================== High-Z Output ==============================
  {
    internalName: 'highz',
    name: 'High-Z Output',
    levelDesc: `A component's output is said to be high Z (high impedance) when it isn't driven by the component. \
In this level you must construct a gated inverter that takes a second \`output_enable\` signal. \
Your gated inverter must drive the output if and only if \`output_enable\` is high.

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
probe("??A", not_A)

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
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_not_A', netName: '??A', reqs: reqSeq(self.clockDivider, 'zzzz101z') },
    ]),
    xStep: 5,
    simSteps: 400,
    clockDivider: 10,
    tickSpacing: 1,
  },

  // ============================== Logic Gates ==============================
  {
    internalName: 'logic_gates',
    name: 'Logic Gates',
    levelDesc: `We will now create logic gates. Implement each of the listed gate functions.

These definitions will be extremely useful, so you may wish to copy some or all of them to later levels as well.

All your logic gate implementations must drive their output even if an input is undriven (high Z) so long as the other input(s) are sufficient to determine the output. \
For example, your AND implementation must drive the output low if one input is low and the other is undriven.

Do not worry if your gate implementations produce garbage outputs for a small amount of time after their inputs switch. \
This is a normal part of combinational logic, and is known as the propagation delay. Some nomenclature:

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
probe("??A", not_out)
probe("??(A ??? B)", nand_out)
probe("A ??? B", and_out)
probe("A ??? B", or_out)
probe("A ??? B", xor_out)
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
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_not_out',  netName: '??A',           reqs: reqSeq(self.clockDivider, '10101010zz10z') },
      { net: '_net_nand_out', netName: '??(A ??? B)',     reqs: reqSeq(self.clockDivider, '111011101z1zz') },
      { net: '_net_and_out',  netName: 'A ??? B',        reqs: reqSeq(self.clockDivider, '000100010z0zz') },
      { net: '_net_or_out',   netName: 'A ??? B',        reqs: reqSeq(self.clockDivider, '01110111z1z1z') },
      { net: '_net_xor_out',  netName: 'A ??? B',        reqs: reqSeq(self.clockDivider, '01100110zzzzz') },
      { net: '_net_mux_out',  netName: 'mux(C, A, B)', reqs: reqSeq(self.clockDivider, '01010011zz01z') },
    ]),
    xStep: 4,
    simSteps: 400,
    clockDivider: 10,
    tickSpacing: 1,
  },

  // ============================== Adder ==============================
  {
    internalName: 'adder',
    name: 'Adder',
    levelDesc: `Your goal is to implement a 3-bit + 3-bit to 3-bit two's complement adder (throwing away the carry bit). \
The numbers are all little-endian, and thus the first bit in a list is the lowest order.`,
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
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_sum0', netName: '(A + B)[0]', reqs: reqSeq(self.clockDivider, 'xx0xx1xx0xx0') },
      { net: '_net_sum1', netName: '(A + B)[1]', reqs: reqSeq(self.clockDivider, 'xx0xx0xx1xx0') },
      { net: '_net_sum2', netName: '(A + B)[2]', reqs: reqSeq(self.clockDivider, 'xx0xx0xx0xx0') },
    ]),
    xStep: 3,
    simSteps: 400,
    clockDivider: 10,
    tickSpacing: 1,
  },

  // ============================== Flip-Flops ==============================
  {
    internalName: 'flipflops',
    name: 'Flip-Flops',
    levelDesc: `Your goal is to implement three components that each store one bit of data:

Set-reset latch (SR latch):
The SR latch has two inputs: set and reset, and two outputs: Q and ??Q. \
When set is high and reset low, Q immediately goes high and ??Q low. \
When reset is high and set is low, Q immediately goes low and ??Q high. \
When both set and reset are both low the output state holds the last value.

D flip-flop based register:
The register has two inputs, D and clk, and two outputs, Q and ??Q. \
The register stores a single bit, which it outputs to Q and ??Q at all times. \
The behavior is that on the rising edge of the clk signal the register samples D, and sets the bit of state equal to it.

(Hint: You can use two SR latches to make this register.)

Don't fret if your register can give the wrong output (or even enter funny states where the output oscillates) if the D signal changes too close to the rising clock edge. \
Your register will have a characteristic setup time and hold time:

  Setup time: Min time that D must have its target value *before* the rising clock edge to avoid malfunction.
  Hold time: Min time that D must hold its target value *after* the rising clock edge to avoid malfunction.
`,
    startingCode: `
def sr_latch(s, r):
    q, not_q = new_net(), new_net()
    ...
    return q, not_q

def register(d, clk):
    q, not_q = new_net(), new_net()
    ...
    return q, not_q

set, reset, d, clk = get_level_inputs()
q, not_q, register_out = get_level_outputs()

for a, b in zip(sr_latch(set, reset), (q, not_q)):
    wire_together(a, b)

wire_together(register(d, clk)[0], register_out)

probe("SR latch's set", set)
probe("SR latch's reset", reset)
probe("SR latch's Q", q)
probe("SR latch's ??Q", not_q)

probe("Register's D", d)
probe("Register's clk", clk)
probe("Register's output", register_out)
`,
    makeInputNets: (components: EComponent[]) => {
      components.push(
        { kind: 'signal', net: '_net_set',   pattern: [...'010000000100000'] as any, repeat: false },
        { kind: 'signal', net: '_net_reset', pattern: [...'000001000000010'] as any, repeat: false },
        { kind: 'signal', net: '_net_d',     pattern: [...'0000011000000110'] as any, repeat: false },
        { kind: 'signal', net: '_net_clk',   pattern: [...'00110011001100110'] as any, repeat: false },
      );
      return ['_net_set', '_net_reset', '_net_d', '_net_clk'];
    },
    makeOutputNets: () => ['_net_q', '_net_not_q', '_net_register_out'],
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_q',            netName: "SR latch's Q",      reqs: reqSeq(self.clockDivider, 'xx111x000x111x000') },
      { net: '_net_not_q',        netName: "SR latch's ??Q",     reqs: reqSeq(self.clockDivider, 'xx000x111x000x111') },
      { net: '_net_register_out', netName: "Register's output", reqs: reqSeq(self.clockDivider, 'xxx000x111x000x11') },
    ]),
    xStep: 3,
    simSteps: 400,
    clockDivider: 10,
    tickSpacing: 1,
  },

  // ============================== State machines ==============================
  {
    internalName: 'state_machine',
    name: 'State Machines',
    levelDesc: `This level is much harder than all previous. \
Your goal will be to implement a circuit that takes in decimal digits one at a time over a serial bus, and outputs if the number is a multiple of seven. \
On each rising clock edge you must read the \`reset\` and \`data_in\` lines, and update your state and the output line. \
You will receive decimal digits as sets of four bits, encoded in big-endian, transmitted over four consecutive clock cycles.

Let us use strings to represent possible inputs over the serial bus to your circuit. \
We will denote a cycle in which \`reset\` is high by "R", and otherwise denote the value of \`data_in\` by either "0", or "1". \
Therefore, "R0000" will denote the input in which the clock has five rising edges, the first where \`reset\` is high \
(and therefore \`data_in\`'s value doesn't matter), and the remaining where \`reset\` is low and \`data_in\` is low.

This input of "R0000" would correspond to feeding in just the single decimal digit 0 to our circuit. \
After receiving this input the output \`div7\` must be high. \
Likewise, the input of "R00010111" would correspond to feeding in the decimal digits 1, then 7, representing the number 17. \
This is not a multiple of seven, so \`div7\` would be required to be low after this input.

As another example, if fed "R0001R0111" your circuit must set \`div7\` low after the first digit is ingested, but then must set \`div7\` high at the very end, because the second reset throws away the first 1 digit. \
Therefore, the number being processed at the very end is just 7, not 17.

Your circuit must work for arbitrarily large numbers. \
You will only be graded on your output after each complete digit is fed in, and you won't be graded on your output before any digits are fed in or before the first reset. \
Nor will you be graded on inputs like "R1010" that use invalid digits.

The test cases being fed in are:
0 (yes)
1 (no)
7 (yes)
14 (no (after just the first digit has been fed in), then yes)
17 (no, then no)
791 (yes, then no, then yes)
`,
    startingCode: `
clk, reset, data_in = get_level_inputs()
div7, = get_level_outputs()

probe("Clock", clk)
probe("Reset", reset)
probe("Data in", data_in)
probe("Divisible by 7?", div7)
`,
    makeInputNets: (components: EComponent[]) => {
      components.push(
        { kind: 'signal', net: '_net_clk',     pattern: [...'01010101010101010101010101010101010101010101010101010101010101010101010101010101010101010101z'] as any, repeat: false },
        { kind: 'signal', net: '_net_reset',   pattern: [...'11000000001100000000110000000011000000000000000011000000000000000011000000000000000000000000z'] as any, repeat: false },
        { kind: 'signal', net: '_net_data_in', pattern: [...'zz00000000zz00000011zz00111111zz0000001100110000zz0000001100111111zz001111111100001100000011z'] as any, repeat: false },
        //                                                   xxxxxxxxxx1xxxxxxxxx0xxxxxxxxx1xxxxxxxxx0xxxxxxx1xxxxxxxxx0xxxxxxx0xxxxxxxxx1xxxxxxx0xxxxxxx1
      );
      return ['_net_clk', '_net_reset', '_net_data_in'];
    },
    makeOutputNets: () => ['_net_div7'],
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxx1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), failureMessages: ['The input being tested at this point is 0, which is divisible by seven',                                         '0 is divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxx0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), failureMessages: ['The input being tested at this point is 1, which is not divisible by seven',                                     '1 is not divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxx1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), failureMessages: ['The input being tested at this point is 7, which is divisible by seven',                                         '7 is divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), failureMessages: ['The input being tested at this point is 1 (just the first digit of 14), which is not divisible by seven',        '1 is not divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), failureMessages: ['The input being tested at this point is 14, which is divisible by seven',                                        '14 is divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx0xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), failureMessages: ['The input being tested at this point is 1 (just the first digit of 17), which is not divisible by seven',        '1 is not divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx0xxxxxxxxxxxxxxxxxxxxxxxxxx'), failureMessages: ['The input being tested at this point is 17, which is not divisible by seven',                                    '17 is not divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1xxxxxxxxxxxxxxxx'), failureMessages: ['The input being tested at this point is 7 (just the first digit of 791), which is divisible by seven',           '7 is divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx0xxxxxxxx'), failureMessages: ['The input being tested at this point is 79 (just the first two digits of 791), which is not divisible by seven', '79 is not divisible'] },
      { net: '_net_div7', netName: "Divisible by 7?", reqs: reqSeq(self.clockDivider, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1'), failureMessages: ['The input being tested at this point is 791, which is divisible by seven',                                       '791 is divisible'] },
    ]),
    xStep: 0.3 / 5,
    simSteps: 3000 * 5,
    clockDivider: 30 * 5,
    tickSpacing: 2,
  },

  // ============================== SRAM ==============================
  {
    internalName: 'sram',
    name: 'SRAM',
    levelDesc: `This level isn't complete yet. Come back later.`,
    startingCode: '# Your code here.\n',
    makeInputNets: () => ['_net_A', '_net_output_enable'],
    makeOutputNets: () => ['_net_notA'],
    gradeResults: (x: any) => ({ success: false, failureTime: 3, message: 'bad', miniMessage: '?' }),
    xStep: 0.3 / 5,
    simSteps: 3000 * 5,
    clockDivider: 30 * 5,
    tickSpacing: 2,
  },

  // ============================== Microprocessor ==============================
  {
    internalName: 'microprocessor',
    name: 'Microprocessor',
    levelDesc: `This is the first level.
To open up the documentation press `,
    startingCode: '# Your code here.\n',
    makeInputNets: () => ['_net_A', '_net_output_enable'],
    makeOutputNets: () => ['_net_notA'],
    gradeResults: (x: any) => ({ success: false, failureTime: 3, message: 'bad', miniMessage: '?' }),
    xStep: 1,
    simSteps: 400,
    clockDivider: 10,
    tickSpacing: 1,
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

interface ITextEditorProps {
  startingCode: string;
  extraKeysMaker: (textEditorComponent: TextEditor) => any;
  getSavedCode: () => string;
}

interface ITextEditorState {
  code: string;
}

class TextEditor extends React.PureComponent<ITextEditorProps, ITextEditorState> {
  constructor(props: ITextEditorProps) {
    super(props);
    this.state = { code: props.startingCode };
  }

  render() {
    return <div>
      <ControlledCodeMirror
        value={this.state.code}
        options={{
          mode: 'python',
          theme: 'material',
          lineNumbers: true,
          indentUnit: 4,
          lineWrapping: true,
          extraKeys: this.props.extraKeysMaker(this),
        }}
        onBeforeChange={(editor, data, code) => {
          this.setState({ code });
        }}
      />
      {this.props.getSavedCode() !== this.state.code &&
        <div style={{
          position: 'absolute',
          right: 20,
          bottom: 20,
          userSelect: 'none',
          pointerEvents: 'none',
          zIndex: 5,
          color: 'red',
          opacity: 0.5,
        }}>
          ??? Unsaved (ctrl + s to save)
        </div>
      }
    </div>;
  }
}

interface IAppState {
  page: 'level-select' | 'level';
  currentLevel: ILevel;
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
  textEditorRef = React.createRef<TextEditor>();

  constructor(props: {}) {
    super(props);

    // Load level states from localStorage.
    this.levelStates = new Map<string, ILevelState>(); // Silence the error.
    this.loadLevelStatesFromLocalStorage();

    this.state = {
      page: 'level-select',
      currentLevel: null as unknown as ILevel,
      //code: '',
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

    var cheatIndex = 0;
    const cheatSequence = 'unlock';
    document.addEventListener('keydown', (evt) => {
      if (evt.key === cheatSequence[cheatIndex]) {
        cheatIndex++;
        if (cheatIndex >= cheatSequence.length)
          this.setState({ cheatMode: true });
      } else {
        cheatIndex = 0;
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
    const lineOfCode = this.getCode().split('\n')[lineNum - 1];
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
    const tracedNets = new Set<string>();
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
          tracedNets.add(component.net);
          break;
        case 'trace':
          for (const net of component.nets)
            tracedNets.add(net);
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
        case 'sram':
          descArray.push(
            4,
            component.address_nets.length, // address bit count
            component.bus_in_nets.length,  // word size
            netIndices.get(component.write_enable_net)!,
            component.contents.length,
            ...component.contents,
            ...component.address_nets.map((net) => netIndices.get(net)!),
            ...component.bus_in_nets.map((net) => netIndices.get(net)!),
            ...component.bus_out_nets.map((net) => netIndices.get(net)!),
          );
          break;
        default:
          continue;
      }
      descArray.push(123456789);
    }
    const desc = new Uint32Array(descArray);
    const netsToTraceNativeArray = new Uint32Array(Array.from(tracedNets).map((net) => netIndices.get(net)!));
    //console.log('[SNP] netsToTraceNativeArray:', netsToTraceNativeArray);
    const traceValues = perform_simulation(
      desc,
      netsToTraceNativeArray,
      netIndices.size,
      this.state.currentLevel.simSteps,
      this.state.currentLevel.clockDivider,
    );
    const traceIndices = get_indices();
    //console.log('[SNP] Trace indices:', traceIndices);
    const traces: Uint8Array[] = [];
    //let shootThroughOccurred = false;
    //let earliestShootThrough = Infinity;
    for (let i = 0; i < traceIndices.length; i += 2) {
      const start = traceIndices[i];
      const len = traceIndices[i + 1];
      const trace = traceValues.slice(start, start + len);
      traces.push(trace);
    }
    const earliestShootThrough = get_first_shoot_through();
    const shootThroughOccurred = earliestShootThrough !== -1;

    //console.log('[SNP] Raw trace data:', traces);

    const netTraces = new Map<string, Uint8Array>();
    let i = 0;
    for (const net of tracedNets)
      netTraces.set(net, traces[i++]);

    //console.log('[SNP] Floop:', tracedNets);
    //console.log('[SNP] Traces:', netTraces);

    const elapsed = performance.now() - startTime;
    let simOutput = `------- Simulation completed in: ${Math.round(elapsed)}ms (Components: ${components.length - 2} Nets: ${nets.size})`;
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
      : this.state.currentLevel.gradeResults(this.state.currentLevel, simResults);

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

    Sk.builtins.make_sram = (address_nets: any, bus_in_nets: any, bus_out_nets: any, write_enable_net: any, contents: any) => {
      address_nets = Sk.ffi.remapToJs(address_nets);
      bus_in_nets = Sk.ffi.remapToJs(bus_in_nets);
      bus_out_nets = Sk.ffi.remapToJs(bus_out_nets);
      write_enable_net = Sk.ffi.remapToJs(write_enable_net);
      contents = Sk.ffi.remapToJs(contents);
      if ([address_nets, bus_in_nets, bus_out_nets, write_enable_net].includes(undefined))
        throw 'too few arguments to: make_sram(address_nets: List[Net], bus_in_nets: List[Net], bus_out_nets: List[Net], write_enable_net: Net, contents: List[int] = [])';
      if (bus_in_nets.length !== bus_out_nets.length)
        throw 'make_sram must take the same number of bus_in_nets and bus_out_nets ??? both are the word size of the memory';
      components.push({
        kind: 'sram',
        contents: new Uint32Array(contents),
        address_nets,
        bus_in_nets,
        bus_out_nets,
        write_enable_net,
      });
    };
    Sk.builtins.make_sram.co_varnames = ['address_nets', 'bus_in_nets', 'bus_out_nets', 'write_enable_net', 'contents'];
    Sk.builtins.make_sram.$defaults = [undefined, undefined, undefined, undefined, []];
    Sk.builtins.make_sram.co_numargs = 5;

    Sk.builtins.get_level_inputs = () => {
      const nets = this.state.currentLevel.makeInputNets(components);
      return Sk.ffi.remapToPy(nets);
    };
    Sk.builtins.get_level_inputs.co_varnames = [];
    Sk.builtins.get_level_inputs.co_numargs = 0;

    Sk.builtins.get_level_outputs = () => {
      const nets = this.state.currentLevel.makeOutputNets(components);
      // Ensure that the output nets are actually traced by the simulator, so we may actually read their values.
      components.push({ kind: 'trace', nets });
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
      //code: this.levelStates.get(level.internalName)!.code,
      terminalOutput: '',
      simOutput: '(Hit ctrl + enter in the code window to rerun.)',
      simResults: null,
      grading: null,
      paneColor: '#222',
    });
    //this.setCode(this.levelStates.get(level.internalName)!.code);
    /*
    if (this.codeMirrorRef.current !== null)
      (this.codeMirrorRef.current as any).value = this.state.currentLevel.startingCode;
    */

    const levelState = this.levelStates.get(level.internalName)!;
    levelState.metadata.everOpened = true;
    persistLevelState(level.internalName, levelState);

    window.history.pushState({page: 'level', currentLevel: level.internalName}, 'Make a Microprocessor');
  }

  getIsUnsaved = (): boolean => this.getCode() !== this.getSavedCode();

  getSavedCode = (): string => this.levelStates.get(this.state.currentLevel.internalName)!.code;

  navigateBack() {
    if (!this.getIsUnsaved() || window.confirm('Exit level without saving work? (Just hit ctrl+s in the code editor.)'))
      this.setState({ page: 'level-select' });
  }

  setCode(code: string) {
    if (this.textEditorRef.current !== null)
      this.textEditorRef.current.setState({ code });
  }

  getCode(): string {
    if (this.textEditorRef.current !== null)
      return this.textEditorRef.current.state.code;
    return 'raise Exception("Internal bug: textEditorRef is null")';
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
                    margin: 5,
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
                    ???
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
          By Peter Schmidt-Nielsen (v0.3c)
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
          <div style={{ display: 'flex', alignItems: 'center', background: '#444', borderBottom: '2px solid #222', height: 60 }}>
            <div
              style={{
                bottom: 10,
                right: 70,
              }}
              className='mainButton'
              onClick={() => this.navigateBack()}
            >
              ???
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
                  this.setCode(this.state.currentLevel.startingCode);
                  //this.setState({ code: this.state.currentLevel.startingCode });
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

          <TextEditor
            ref={this.textEditorRef}
            startingCode={this.levelStates.get(this.state.currentLevel.internalName)!.code}
            getSavedCode={this.getSavedCode}
            extraKeysMaker={(textEditorComponent: TextEditor) => ({
              'Ctrl-Enter': (cm: any) => {
                this.onCompile(textEditorComponent.state.code);
                //this.props.onCompile(this.getCode());
              },
              'Ctrl-S': (cm: any) => {
                const levelState = this.levelStates.get(this.state.currentLevel.internalName)!;
                levelState.code = textEditorComponent.state.code;
                persistLevelState(this.state.currentLevel.internalName, levelState);
                this.forceUpdate();
              },
              /*'Tab': (cm: any) => {
                cm.replaceSelection('  ', 'end');
              },*/
            })}
          />
          {
          // <UnControlledCodeMirror
          //   ref={this.codeMirrorRef}
          //   value={this.getCode()}
          //   options={codeMirrorOptions(this.onCompile)}
          //   /*
          //   onBeforeChange={(editor, data, code) => {
          //     this.setState({ code });
          //   }}
          //   */
          // />
          }
        </div>

        <div>
          {/*
          <SplitPane
            split="horizontal"
            minSize={30}
            defaultSize={horizSplitDefault}
            onChange={(size) => localStorage.setItem('split2', size.toString())}
            resizerStyle={horizResizeStyle}
          >
          */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <div style={{
              width: '100%',
              height: '60vh',
              backgroundColor: '#333',
              color: 'white',
              fontFamily: 'monospace',
              overflow: 'scroll',
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
                  renderTraces(this.state.currentLevel, this.state.simResults, this.state.grading!)
                }
              </div>
            </div>

            <div style={{
              backgroundColor: this.state.paneColor,
              color: 'white',
              fontFamily: 'monospace',
              width: '100%',
              height: '40vh',
              display: 'flex',
              //overflowY: 'scroll',
            }}>
              <div style={{ padding: 10, width: 500, backgroundColor: '#222', overflowY: 'scroll' }}>
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
                overflow: 'scroll',
                width: '100%',
              }}>
                {this.state.terminalOutput && <>
                  Python output:<br/>
                  <span style={{color: 'lightblue'}}>{this.state.terminalOutput}</span><br/>
                  <br/>
                </>}
                {this.state.simOutput}
              </div>
            </div>
          </div>
          {/* </SplitPane> */}
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
        backgroundColor: '#aaa',
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
            ???
          </div>
        </div>

        <span style={{ fontSize: '150%', fontWeight: 'bold' }}>Parts list</span>
        <div style={{ marginTop: 10 }}>
          The code area is "Python". Hit ctrl + enter in the code area to rerun it, and hit ctrl + s to save your code.
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

              There is no modeled body diode, so the FET simply does nothing (doesn't conduct) if source is high and drain is low (pass transistor logic is not allowed).
              Additionally, no gate capacitance is modeled ??? all nets that aren't driven return to a floating state which doesn't switch FETs on.
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

          In the last two levels we will also use the SRAM component:

          <div style={{ marginLeft: 20, marginBottom: 20 }}>
            <pre style={{ fontWeight: 'bold', fontSize: '120%' }}>{`make_sram(
  # Input nets that are the bits of the address. (Length sets the address size.)
  address_nets: List[Net],

  # Input nets to give the value when writing. (Length sets the word size.)
  bus_in_nets: List[Net],

  # Output nets driven by the SRAM when reading. (Must be same length as bus_in_nets.)
  bus_out_nets: List[Net],

  # Drive write_enable_net low to read, drive high to write.
  write_enable_net: Net,

  # An optional list of initial values for the SRAM.
  # (Length may be at most 2**len(address_nets), remaining words are uninitialized.)
  contents: List[int] = [],
)`}</pre>
            <div style={{ marginLeft: 20 }}>
              Constructs a read-write word-addressed SRAM, optionally initialized with some chosen data.
              Drive the <code>address_nets</code> to select a word in the memory.

              If <code>write_enable_net</code> is low then the selected memory word is read, and the <code>bus_out_nets</code> are driven with its value.
              If <code>write_enable_net</code> is high then the selected memory word is updated to be equal to the value on <code>bus_in_nets</code>, and the <code>bus_out_nets</code> are high-Z.
              The <code>bus_in_nets</code> are always high-Z.
              There are no setup or hold times (the SRAM is modeled as nearly instant), and the propagation and contamination delays are also nearly instant.

              Example:
              <pre style={{ marginLeft: 20 }}>{
`address_nets = [new_net() for _ in range(12)]
bus_in_nets  = [new_net() for _ in range(4)]
bus_out_nets = [new_net() for _ in range(4)]
write_enable_net = new_net()

# Constructs an SRAM that can address 2**12 distinct 4-bit words.
make_sram(
    address_nets,
    bus_in_nets,
    bus_out_nets,
    write_enable_net,
    # Initialize all 2**12 of the words to be 1010.
    # This initializer argument is optional.
    [0b1010 for _ in range(2**12)],
)`
              }</pre>

              If you do not use the optional contents intializer then the endianness of the address and bus lines is unobservable,
              and you may of course use the address lines and bus lines in any scrambled order you please.
              However, the contents initializer breaks this symmetry; the address and bus lines are little-endian wrt the initializer.
              That is, <code>(contents[addr] &gt;&gt; bit) &amp; 1</code> is the value you will see on <code>bus_out_nets[bit]</code> when <code>address_nets[i] == (addr &gt;&gt; i) &amp; 1</code>
            </div>
          </div>

        </div>
      </div>
    </div>;
  }
}

export default App;
