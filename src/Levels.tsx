import { ISimResults, EComponent } from './App';

export interface IGrading {
  success: boolean;
  failureTime: number;
  message: string;
  miniMessage: string;
}

export interface ILevel {
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

export const globalLevelsList: ILevel[] = [
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
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_not_A', netName: '¬A', reqs: reqSeq(self.clockDivider, '1010') },
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
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_not_A', netName: '¬A', reqs: reqSeq(self.clockDivider, 'zzzz101z') },
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
    gradeResults: (self: ILevel, simResults: ISimResults) => doGrading(simResults, [
      { net: '_net_not_out',  netName: '¬A',           reqs: reqSeq(self.clockDivider, '10101010zz10z') },
      { net: '_net_nand_out', netName: '¬(A ∧ B)',     reqs: reqSeq(self.clockDivider, '111011101z1zz') },
      { net: '_net_and_out',  netName: 'A ∧ B',        reqs: reqSeq(self.clockDivider, '000100010z0zz') },
      { net: '_net_or_out',   netName: 'A ∨ B',        reqs: reqSeq(self.clockDivider, '01110111z1z1z') },
      { net: '_net_xor_out',  netName: 'A ⊕ B',        reqs: reqSeq(self.clockDivider, '01100110zzzzz') },
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
The SR latch has two inputs: set and reset, and two outputs: Q and ¬Q. \
When set is high and reset low, Q immediately goes high and ¬Q low. \
When reset is high and set is low, Q immediately goes low and ¬Q high. \
When both set and reset are both low the output state holds the last value.

D flip-flop based register:
The register has two inputs, D and clk, and two outputs, Q and ¬Q. \
The register stores a single bit, which it outputs to Q and ¬Q at all times. \
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
probe("SR latch's ¬Q", not_q)

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
      { net: '_net_not_q',        netName: "SR latch's ¬Q",     reqs: reqSeq(self.clockDivider, 'xx000x111x000x111') },
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
