import React from 'react';
import './App.css';
import { Controlled as ControlledCodeMirror } from 'react-codemirror2';
import 'codemirror/lib/codemirror.css';
import 'codemirror/theme/material.css';
import 'codemirror/mode/python/python';
import RawCodeMirror from 'codemirror';
import SplitPane from 'react-split-pane';
import { IGrading, ILevel, globalLevelsList } from './Levels';

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

export interface EFet {
  kind: 'fet';
  isPfet: boolean;
  gate: string;
  drain: string;
  source: string;
}

export interface EPullResistor {
  kind: 'pull_resistor';
  direction: 'up' | 'down';
  net: string;
}

export interface EProbe {
  kind: 'probe';
  label: string;
  net: string;
}

export interface ETrace {
  kind: 'trace';
  nets: string[];
}

export interface EWire {
  kind: 'wire';
  nets: string[];
}

export interface EButton {
  kind: 'button';
  net: string;
}

export interface ESignal {
  kind: 'signal';
  net: string;
  pattern: ('0' | '1' | 'z')[];
  repeat: boolean;
}

export interface ESram {
  kind: 'sram';
  contents: Uint32Array;
  address_nets: string[];
  bus_in_nets: string[];
  bus_out_nets: string[];
  write_enable_net: string;
}

export type EComponent = (
  EFet |
  EPullResistor |
  EProbe |
  ETrace |
  EWire |
  EButton |
  ESignal |
  ESram
);

function builtinRead(x: string) {
  const Sk = (window as any).Sk;
  if (Sk.builtinFiles === undefined || Sk.builtinFiles["files"][x] === undefined)
    throw "File not found: '" + x + "'";
  return Sk.builtinFiles["files"][x];
}

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

export interface ISimResults {
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
          ⬤ Unsaved (ctrl + s to save)
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
        throw 'make_sram must take the same number of bus_in_nets and bus_out_nets — both are the word size of the memory';
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
            ✕
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
