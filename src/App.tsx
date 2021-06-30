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

function renderTraces(simResults: ISimResults) {
  const width = 800;
  const height = 30 * simResults.probes.length;

  const svgContents = [];

  let probeIndex = 0;

  for (const probe of simResults.probes) {
    const forwardPass: string[] = [];
    const backwardPass: string[] = [];
    const xStep = 5;
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
          shootThroughStart !== -1 &&
          <path
            d={`M ${shootThroughStart} 3 L ${width - 3} 3 L ${width - 3} 27 L ${shootThroughStart} 27 Z`}
            stroke='red'
            strokeWidth={3}
            fill='rgba(255, 0, 0, 0.3)'
          />
        }
      </g>
    );
    probeIndex++;
  }

  return <svg style={{
    width, height,
  }}>
    {svgContents}
  </svg>;
}

interface ILevel {
  internalName: string;
  name: string;
  levelDesc: string;
  startingCode: string;
}

const globalLevelsList: ILevel[] = [
  {
    internalName: 'fets',
    name: 'FETs',
    levelDesc: `This is the first level.
To open up the documentation press `,
    startingCode: '# Your code here.\n',
  },
];

interface ISimResults {
  components: number;
  nets: string[];
  netTraces: Map<string, Uint8Array>;
  probes: EProbe[];
  shootThroughOccurred: boolean;
}

interface IAppState {
  page: 'level-select' | 'level';
  currentLevel: string;
  levelStates: Map<string, ILevelState>;
}

interface ILevelState {
  metadata: {
    everOpened: boolean;
    everBeaten: boolean;
  };
  code: string;
  terminalOutput: string;
  pythonOutput: string;
  simResult: null | ISimResults;
}

class App extends React.PureComponent<{}, IAppState> {
  constructor(props: {}) {
    super(props);
    const levelStates = new Map<string, ILevelState>();
    for (const level of globalLevelsList) {
      const metadata = JSON.parse(
        localStorage.getItem('level-' + level.internalName + '-meta')
        || '{"everBeaten": false, "everOpened": false}'
      );
      const code = localStorage.getItem('level-' + level.internalName + '-saved-code') || level.startingCode;
      levelStates.set(level.internalName, {
        metadata,
        code,
        terminalOutput: '(Hit ctrl + enter in the code window to rerun.)',
        pythonOutput: '',
        simResult: null,
      });
    }

    this.state = {
      page: 'level-select',
      currentLevel: '',
      levelStates,
    };
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
        case 'pull_resistor':
          descArray.push(
            2,
            {'up': 0, 'down': 1}[component.direction],
            netIndices.get(component.net)!,
          );
          break;
        case 'signal':
          descArray.push(
            3,
            netIndices.get(component.net)!,
            +component.repeat,
            component.pattern.length,
            ...[...component.pattern].map((c) => ({'0': 0, '1': 1, 'z': 2}[c])),
          );
          break;
        default:
          continue;
      }
      descArray.push(123456789);
    }
    const desc = new Uint32Array(descArray);
    const traceValues = perform_simulation(desc, netIndices.size, 100, 10);
    const traceIndices = get_indices();
    const traces: Uint8Array[] = [];
    let shootThroughOccurred = false;
    for (let i = 0; i < traceIndices.length; i += 2) {
      const start = traceIndices[i];
      const len = traceIndices[i + 1];
      const trace = traceValues.slice(start, start + len);
      for (const v of trace)
        if (v == 3)
          shootThroughOccurred = true;
      traces.push(trace);
    }

    const netTraces = new Map<string, Uint8Array>();
    for (const net of nets)
      netTraces.set(net, traces[netIndices.get(net)!]);

    let simOutput = `Components: ${components.length - 2}  Nets: ${nets.size}`;
    const simResult: ISimResults = {
      components: components.length,
      nets: [...nets],
      netTraces,
      probes,
      shootThroughOccurred,
    };
    this.setState({ components, simOutput, simResult });
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
      components.push({ kind: 'fet', isPfet: true, gate, drain, source });
    };
    Sk.builtins.pfet.co_varnames = ['gate', 'drain', 'source'];
    Sk.builtins.pfet.$defaults = [undefined, undefined, undefined];
    Sk.builtins.pfet.co_numargs = 3;

    Sk.builtins.probe = (label: string, net: any) => {
      label = Sk.ffi.remapToJs(label);
      net = Sk.ffi.remapToJs(net);
      components.push({ kind: 'probe', label, net });
    };
    Sk.builtins.probe.co_varnames = ['label', 'net'];
    Sk.builtins.probe.co_numargs = 2;

    Sk.builtins.pull_down_resistor = (net: any) => {
      net = Sk.ffi.remapToJs(net);
      components.push({ kind: 'pull_resistor', direction: 'down', net });
    };
    Sk.builtins.pull_down_resistor.co_varnames = ['net'];
    Sk.builtins.pull_down_resistor.co_numargs = 1;

    Sk.builtins.pull_up_resistor = (net: any) => {
      net = Sk.ffi.remapToJs(net);
      components.push({ kind: 'pull_resistor', direction: 'up', net });
    };
    Sk.builtins.pull_up_resistor.co_varnames = ['net'];
    Sk.builtins.pull_up_resistor.co_numargs = 1;

    Sk.builtins.wire_together = (nets: any) => {
      nets = Sk.ffi.remapToJs(nets);
      components.push({ kind: 'wire', nets });
    };
    Sk.builtins.wire_together.co_varnames = ['nets'];
    Sk.builtins.wire_together.co_numargs = 1;

    Sk.builtins.button = () => {
      const net = 'button' + getId();
      components.push({ kind: 'button', net });
      return Sk.ffi.remapToPy(net);
    };
    Sk.builtins.button.co_varnames = [];
    Sk.builtins.button.co_numargs = 0;

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

  oldOnCompile(code: string) {
    const lines = code.split('\n');
    let lineNum = 0;
    const components: any[] = [];
    for (let line of lines) {
      lineNum++;
      line = line.split('//')[0];
      if (line.length === 0)
        continue;
      const comp = line.split(/ +/);
      if (comp[0] === 'nfet' || comp[0] === 'pfet') {
        if (comp.length !== 4)
          return this.reportError(lineNum, 'FET must take three arguments: nfet/pfet gate drain source');
        components.push({ kind: comp[0], gate: comp[1], drain: comp[2], source: comp[3] });
      } else if (comp[0] === 'probe' || comp[0] === 'wire') {
        if (comp.length === 1)
          return this.reportError(lineNum, `${comp[0]} takes a list of nets to monitor, like: ${comp[0]} net0 net1 net2...`);
        components.push({ kind: comp[0], nets: comp.slice(1) });
      } else if (comp[0] === 'button') {
        if (comp.length !== 2)
          return this.reportError(lineNum, `button takes a single output net, like: button net`);
        components.push({ kind: 'button', net: comp[1] })
      } else if (comp[0] === 'signal') {
        if (comp.length !== 3)
          return this.reportError(lineNum, 'signal takes a net and a description of the signal, like: signal clock 01... \nThe signal must be made of 0s and 1s, and may optionally end with ... to indicate that the signal should repeat.');
        const repeat = comp[2].endsWith('...');
        if (repeat)
          comp[2] = comp[2].slice(0, -3);
        for (const c of comp[2])
          if (c !== '0' && c !== '1')
            return this.reportError(lineNum, 'The signal must be made of 0s and 1s, and may optionally end with ... to indicate that the signal should repeat.');
        components.push({ kind: 'signal', repeat, signal: comp[2], net: comp[1] });
      } else {
        return this.reportError(lineNum, `Invalid component: ${comp[0]} (must be one of: nfet, pfet, probe, wire, button, signal)`);
      }
    }
    this.simulate(components);
  }

  render() {
    if (this.state.page === 'level-select') {
      return <div style={{
        width: '100%',
        height: '100vh',
        background: '#333',
        color: 'white',
        fontFamily: 'monospace',
        fontSize: '200%',
        display: 'flex',
      }}>
        <div style={{
          
        }}>
          This is some content.
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
        <div>
          <ControlledCodeMirror
            value={this.state.code}
            options={codeMirrorOptions(this.onCompile)}
            onBeforeChange={(editor, data, code) => {
              localStorage.setItem('code', code);
              this.setState({ code });
            }}
          />
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
                {this.state.simResult !== null && <>
                  <Collapsible trigger='Nets' transitionTime={100}>
                    {[...this.state.simResult.nets].map((net: any) =>
                      <div key={net}>
                        {net}: 1234
                      </div>
                    )}
                  </Collapsible>
                </>}
                */}

                {this.state.simResult !== null &&
                  /*
                  this.state.simResult.probes.map((probeName) =>
                    <div key={probeName} style={{display: 'flex', justifyContent: 'center', alignContent: 'center', alignItems: 'center'}}>
                      <div>{probeName}:</div>
                      {renderTrace(this.state.simResult!.netTraces.get(probeName)!)}
                    </div>
                  )*/
                  renderTraces(this.state.simResult)
                }
              </div>
            </div>

            <div style={{
              backgroundColor: '#222',
              whiteSpace: 'pre-wrap',
              color: 'white',
              fontFamily: 'monospace',
              width: '100%',
              height: '100%',
              padding: 10,
            }}>
              {this.state.terminalOutput}
              {'\n\n' + this.state.simOutput}
            </div>
          </SplitPane>
        </div>
      </SplitPane>
    </div>;
  }
}

export default App;
