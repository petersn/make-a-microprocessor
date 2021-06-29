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
  generateNumber,
  performSimulation,
} from './wasm-build/libsnpspice.js';

let wasmInitialized = false;
let wasm = init(process.env.PUBLIC_URL + "/libsnpspice_bg.wasm")
  .then(() => wasmInitialized = true);

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

interface IAppState {
  code: string;
  terminalOutput: string;
  simOutput: string;
  components: any[];
  simResult: null | any;
}

class App extends React.PureComponent<{}, IAppState> {
  constructor(props: {}) {
    super(props);
    this.state = {
      code: localStorage.getItem('code') || '# Code\n',
      terminalOutput: '(Hit ctrl + enter in the code window to rerun.)',
      simOutput: '',
      components: [],
      simResult: null,
    };
  }

  reportError(lineNum: number, message: string) {
    const lineOfCode = this.state.code.split('\n')[lineNum - 1];
    this.setState({
      terminalOutput: `  ${lineOfCode}\n\nError on line ${lineNum}: ${message}`,
    });
  }

  simulate(components: any[]) {
    // Find all nets, and verify CMOS design rule.
    const nets = new Set<string>(['vdd', 'gnd']);
    const probes = [];
    for (const component of components) {
      if (component.hasOwnProperty('net'))
        nets.add('' + component.net);
      if (component.hasOwnProperty('nets'))
        for (const net of component.nets)
          nets.add('' + net);
      if (component.kind === 'nfet' || component.kind === 'pfet') {
        nets.add('' + component.gate);
        nets.add('' + component.source);
        nets.add('' + component.drain);
      }
      if (component.kind === 'probe')
        probes.push('' + component.net);
    }

    /*
    for (const verif of ['nfet', 'pfet']) {
      
    }
    */

    //const value = new Map<string, string>();
    //for (const )

    //const value = libsnpspice.getValue();
    if (!wasmInitialized) {
      this.setState({ simOutput: 'Wasm component not initialized.' });
      return;
    }
    const descArray: number[] = [];
    const netIndices = new Map<string, number>();
    for (const net of nets)
      netIndices.set(net, netIndices.size);
    for (const component of components) {
      descArray.push(({
        'nfet': 1,
        'pfet': 2,
        'probe': 3,
        'wire': 4,
        'button': 5,
        'signal': 6,
      } as any)[component.kind]);
      switch (component.kind) {
        case 'nfet':
        case 'pfet':
          descArray.push(
            netIndices.get(component.gate)!,
            netIndices.get(component.drain)!,
            netIndices.get(component.source)!,
          );
          break;
        case 'probe':
          descArray.push(netIndices.get(component.net)!);
          break;
        case 'wire':
          break;
        case 'button':
          break;
        case 'signal':
          descArray.push(component.net);
          descArray.push(0 + component.repeat);
          descArray.push(component.pattern.length);
          descArray.push(...[...component.pattern].map((c) => Number(c)));
          break;
        default: throw `Internal bug: Unknown component: ${component.kind}`;
      }
      descArray.push(123456789);
    }
    console.log(descArray);
    const desc = new Uint32Array(descArray);
    const value = performSimulation(desc, netIndices.size, 1000);
    //const value = 123;
    let simOutput = `Components: ${components.length}  Nets: ${nets.size}  Value: ${value}`;
    const simResult = {
      components, nets, probes,
    };
    this.setState({ components, simOutput, simResult });
  }

  onCompile(code: string) {
    const Sk = (window as any).Sk;
    Sk.pre = "output";
    var results: string[] = [];

    const components: any[] = [];

    var nextId = 0;
    function getId(): string {
      nextId++;
      return nextId.toString();
    }

    Sk.builtins.vdd = 'vdd';
    Sk.builtins.gnd = 'gnd';

    Sk.builtins.new_net = (name: any) => {
      return name.toString() + getId();
    };
    Sk.builtins.new_net.co_varnames = ['name'];
    Sk.builtins.new_net.$defaults = ['net'];
    Sk.builtins.new_net.co_numargs = 1;

    Sk.builtins.nfet = (gate: any, drain: any, source: any) => {
      components.push({ kind: 'nfet', gate, drain, source });
    };
    Sk.builtins.nfet.co_numargs = 3;

    Sk.builtins.pfet = (gate: any, drain: any, source: any) => {
      components.push({ kind: 'pfet', gate, drain, source });
    };
    Sk.builtins.pfet.co_numargs = 3;

    Sk.builtins.probe = (net: any) => {
      components.push({ kind: 'probe', net });
    };
    Sk.builtins.probe.co_numargs = 1;

    Sk.builtins.wire_together = (nets: any) => {
      components.push({ kind: 'wire', nets });
    };
    Sk.builtins.wire_together.co_numargs = 1;

    Sk.builtins.button = () => {
      const net = 'button' + getId();
      components.push({ kind: 'button', net });
    };
    Sk.builtins.button.co_numargs = 0;

    Sk.builtins.signal = (pattern: any, name: any) => {
      const net = name + getId();
      if (pattern === undefined)
        throw 'signal must take pattern, like: signal("01...")';
      pattern = pattern.toString();
      const repeat = pattern.endsWith('...');
      if (repeat)
        pattern = pattern.slice(0, -3);
      for (const c of pattern)
        if (c !== '0' && c !== '1')
          throw 'The signal must be made of 0s and 1s, and may optionally end with ... to indicate that the signal should repeat.';
      components.push({ kind: 'signal', net, pattern, repeat });
      return net;
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
        this.setState({ terminalOutput: err.toString() });
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
    const codeMirrorOptions = (onCompile: (string) => void) => {
      mode: 'python',
      theme: 'material',
      lineNumbers: true,
      indentUnit: 2,
      extraKeys: {
        'Ctrl-Enter': (cm) => {
          onCompile(this.state.code);
        },
        'Ctrl-S': (cm) => {

        },
        'Tab': (cm) => {
          cm.replaceSelection('  ', 'end');
        },
      },
    };

    const vertResizeStyle = {
      background: 'black',
      width: '2px',
      cursor: 'col-resize',
      height: '100%',
    };
    const horizResizeStyle = {
      background: 'black',
      height: '2px',
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
        minSize={30}
        defaultSize={vertSplitDefault}
        onChange={(size) => localStorage.setItem('split1', size.toString())}
        resizerStyle={vertResizeStyle}
      >
        <div>
          <ControlledCodeMirror
            value={this.state.code}
            options={codeMirrorOptions}
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
                {this.state.simResult !== null && <>
                  <Collapsible trigger='Nets' transitionTime={100}>
                    {[...this.state.simResult.nets].map((net: any) =>
                      <div key={net}>
                        {net}: 1234
                      </div>
                    )}
                  </Collapsible>
                </>}
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
