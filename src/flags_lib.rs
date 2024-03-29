
use std::collections::HashMap;
use std::collections::HashSet;
use std::iter::FromIterator;
use once_cell::sync::OnceCell;
use wasm_bindgen::prelude::*;

const SUBSTEPS: u32 = 1;

#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

static mut GLOBAL_INDICES: Vec<u32> = Vec::new();
static mut GLOBAL_FIRST_SHOOT_THROUGH: i32 = -1;

type Net = u32;

type Drive = u8;

const DRIVE_HIGH_Z:      Drive = 0;
const DRIVE_WEAK_LOW:    Drive = 1 << 0;
const DRIVE_WEAK_HIGH:   Drive = 1 << 1;
const DRIVE_STRONG_LOW:  Drive = 1 << 2;
const DRIVE_STRONG_HIGH: Drive = 1 << 3;

enum Component {
  Fet { is_pfet: bool, gate: Net, drain: Net, source: Net },
  Signal { pattern: Vec<Drive>, repeat: bool, net: Net },
  PullResistor { is_pull_down: bool, net: Net },
  Sram {
    address_bit_count: u32,
    word_size: u32,
    contents: Vec<NetState>,
    address_nets: Vec<Net>,
    bus_in_nets: Vec<Net>,
    bus_out_nets: Vec<Net>,
    read_enable_net: Net,
    write_enable_net: Net,
  },
}

#[derive(Clone, Copy)]
#[repr(u8)]
enum DriveType {
  Low = 0,
  High = 1,
  HighZ = 2,
  ShootThrough = 3,
}

#[derive(Clone, Copy)]
#[repr(u8)]
enum NetState {
  Invalid = 0,
  Low = 1,
  High = 2,
  ShootThrough = 3,
}

/*
fn merge_drives(a: DriveType, b: DriveType) -> DriveType {
  match (a, b) {
    // Let strongs override weaks.
    (DriveType::WeakHigh, DriveType::Low) | (DriveType::Low, DriveType::WeakHigh) => DriveType::Low,
    (DriveType::WeakLow, DriveType::High) | (DriveType::High, DriveType::WeakLow) => DriveType::High,

    // Let weaks merge with strongs.
    (DriveType::WeakLow, DriveType::Low) | (DriveType::Low, DriveType::WeakLow) => DriveType::Low,
    (DriveType::WeakHigh, DriveType::High) | (DriveType::High, DriveType::WeakHigh) => DriveType::High,

    // Driving with yourself does nothing.
    (DriveType::WeakLow, DriveType::WeakLow) => DriveType::WeakLow,
    (DriveType::WeakHigh, DriveType::WeakHigh) => DriveType::WeakHigh,
    (DriveType::Low, DriveType::Low) => DriveType::Low,
    (DriveType::High, DriveType::High) => DriveType::High,

    // High-Z drive never does anything.
    (DriveType::HighZ, x) | (x, DriveType::HighZ) => x,

    // Mismatching weaks or mismatching strongs become shoothrough.
    (DriveType::WeakLow, DriveType::WeakHigh) | (DriveType::WeakHigh, DriveType::WeakLow) |
    (DriveType::Low, DriveType::High) | (DriveType::High, DriveType::Low) |
    (_, DriveType::ShootThrough) | (DriveType::ShootThrough, _)
      => DriveType::ShootThrough,
  }
}
*/

fn parse_pattern_var(x: &u32) -> Drive {
  match *x {
    0 => DRIVE_STRONG_LOW,
    1 => DRIVE_STRONG_HIGH,
    2 => DRIVE_HIGH_Z,
    _ => panic!("Invalid pattern var: {}", *x),
  }
}

#[wasm_bindgen]
pub fn init_panic_hook() {
  console_error_panic_hook::set_once();
}

// Performance optimizations to perform:
//   1. Replace this merge_drives function with a proper thing that uses flags then merges them up at the end.
//   2. Maybe have a dirty list, so I don't resimulate everything like every time.

#[wasm_bindgen]
pub fn perform_simulation(
  description: &[u32],
  nets_to_trace: &[u32],
  net_count: u32,
  duration: u32,
  clock_divider: u32,
) -> Vec<u8> {
  // We now unpack everything.
  let mut first_shoot_through: i32 = -1;
  let mut net_states: Vec<NetState> = vec![NetState::Invalid; net_count as usize];
  let mut traces: Vec<Vec<NetState>> = Vec::new();
  for _ in 0..nets_to_trace.len() {
    traces.push(vec![NetState::Invalid]);
  }
  //let mut children: Vec<Vec<Net>> = vec![Vec::new(); net_count as usize];
  //let mut components_by_output_net: Vec<Vec<Component>> =
  //  (0..net_count).into_iter().map(|x| Vec::new()).collect();
  let mut components: Vec<Component> = Vec::new();
  let mut dirty_bitmap: Vec<u64> = Vec::new();

  {
    let mut i: usize = 0;
    while i < description.len() {
      match description[i] {
        1 => {
          let is_pfet = description[i + 1] == 1;
          let gate = description[i + 2];
          let drain = description[i + 3];
          let source = description[i + 4];
          //components_by_output_net[drain as usize].push(Component::Fet{
          components.push(Component::Fet{is_pfet, gate, drain, source});
          //children[gate as usize].push(drain);
          //children[source as usize].push(drain);
          i += 5;
        }
        2 => {
          let net = description[i + 1];
          let repeat = description[i + 2] != 0;
          let length = description[i + 3];
          let pattern = description[i + 4 .. i + 4 + length as usize].iter().map(parse_pattern_var).collect();
          //components_by_output_net[net as usize].push(Component::Signal{pattern, repeat, net});
          components.push(Component::Signal{pattern, repeat, net});
          i += 4 + length as usize;
        }
        3 => {
          let is_pull_down = description[i + 1] == 1;
          let net = description[i + 2];
          components.push(Component::PullResistor{is_pull_down, net});
          i += 3;
        }
        /*4 => {
          let address_bit_count = description[i + 1];
          let word_size = description[i + 2];

          components.push(Component::PullResistor{is_pull_down, net});
        }*/
        _ => panic!("Deserialization failure. Hit: {} at position {} out of length {}", description[i], i, description.len()),
      }
      if i >= description.len() {
        panic!("Deserialization failure. Fell off end where there should be a sentinel.");
      }
      if description[i] != 123456789 {
        panic!("Expected sentinel. Hit: {} at position {} out of length {}", description[i], i, description.len());
      }
      i += 1;
    }
  }

  let mut drives: Vec<Drive> = vec![0; net_count as usize];

  for t in 0..duration {
    let now = (t / clock_divider) as usize;

    for net in 0..net_count {
      drives[net as usize] = DRIVE_HIGH_Z;
    }

    for component in &components {
      match component {
        Component::Fet{is_pfet, gate, drain, source} => {
          let gate_state   = net_states[*gate   as usize];
          let drain_state  = net_states[*drain  as usize];
          let source_state = net_states[*source as usize];
          match (*is_pfet, gate_state, source_state) {
            // Normal operation of nfets and pfets.
            (false, NetState::High, NetState::Low) =>
              drives[*drain as usize] |= DRIVE_STRONG_LOW,
            (true, NetState::Low, NetState::High) =>
              drives[*drain as usize] |= DRIVE_STRONG_HIGH,
            // In all other cases we don't drive.
            _ => (),
          }
        }
        Component::PullResistor{ is_pull_down, net } =>
          drives[*net as usize] |= match is_pull_down {
            true => DRIVE_WEAK_LOW,
            false => DRIVE_WEAK_HIGH,
          },
        Component::Signal{ pattern, repeat, net } => {
          let signal_output: Drive = pattern[match repeat {
            true => now % pattern.len(),
            false => std::cmp::min(now, pattern.len() - 1),
          }];
          drives[*net as usize] |= signal_output;
        }
        Component::Sram{..} => {

        }
      }
    }

    // Update state based on drivings.
    //for (i, mut net_state) in net_states.iter().enumerate().copied() {
    for i in 0..net_count {
      let mut old_state = net_states[i as usize];
      let mut drive = drives[i as usize];
      if drive & (DRIVE_STRONG_LOW | DRIVE_STRONG_HIGH) != 0 {
        drive &= !(DRIVE_WEAK_LOW | DRIVE_WEAK_HIGH);
      }
      let mut drive_type = match drive {
        DRIVE_HIGH_Z => DriveType:: HighZ,
        DRIVE_WEAK_LOW | DRIVE_STRONG_LOW => DriveType::Low,
        DRIVE_WEAK_HIGH | DRIVE_STRONG_HIGH => DriveType::High,
        _ => DriveType::ShootThrough,
      };
      /*
      
      if (*net_state as u8 & DRIVE_WEAK_LOW) && (net_state & DRIVE_WEAK_HIGH) {
        drive_type = DriveType::ShootThrough;
      } else if (net_state & DRIVE_STRONG_LOW) && (net_state & DRIVE_STRONG_HIGH) {
        drive_type = DriveType::ShootThrough;
      } else if net_state & DRIVE_STRONG_LOW {
        drive_type = DriveType::Low;
      } else if (net_state & DRIVE_STRONG_HIGH) || (net_state & DRIVE_WEAK_HIGH) {
        drive_type = DriveType::High;
      } else if net_state & DRIVE_WEAK_LOW {
        drive_type = DriveType::Low;
      }
      */

      let new_state = match (old_state, drive_type) {
        (NetState::ShootThrough, _) => NetState::ShootThrough,
        (_, DriveType::ShootThrough) => NetState::ShootThrough,
        (_, DriveType::HighZ) |
        (NetState::Low, DriveType::High) |
        //(NetState::Low, DriveType::WeakHigh) |
        (NetState::High, DriveType::Low) //|
        //(NetState::High, DriveType::WeakLow)
          => NetState::Invalid,
        (NetState::Invalid, DriveType::Low) => NetState::Low,
        (NetState::Invalid, DriveType::High) => NetState::High,
        (NetState::Low, DriveType::Low) => NetState::Low,
        (NetState::High, DriveType::High) => NetState::High,
        //(NetState::Invalid, DriveType::WeakLow) => NetState::Low,
        //(NetState::Invalid, DriveType::WeakHigh) => NetState::High,
      };
      if first_shoot_through == -1 {
        match new_state {
          NetState::ShootThrough => first_shoot_through = t as i32,
          _ => (),
        }
      }
      //if new_state == NetState::ShootThrough && first_shoot_through == -1 {
      //  first_shoot_through = t;
      //}
      net_states[i as usize] = new_state;
    }

    /*
    // Produce new values.
    for net in 0..streams.len() {
      let last = streams[net][t as usize];
      streams[net].push(match (last, drives[net]) {
        (NetState::ShootThrough, _) => NetState::ShootThrough,
        (_, DriveType::ShootThrough) => NetState::ShootThrough,
        (_, DriveType::HighZ) |
        (NetState::Low, DriveType::High) |
        (NetState::Low, DriveType::WeakHigh) |
        (NetState::High, DriveType::Low) |
        (NetState::High, DriveType::WeakLow)
          => NetState::Invalid,
        (NetState::Invalid, DriveType::Low) => NetState::Low,
        (NetState::Invalid, DriveType::High) => NetState::High,
        (NetState::Invalid, DriveType::WeakLow) => NetState::Low,
        (NetState::Invalid, DriveType::WeakHigh) => NetState::High,
        _ => last,
      });
    }
    */
    
  }

  let mut bytes: Vec<u8> = Vec::new();
  let mut indices: Vec<u32> = Vec::new();

  // Pack up our results.
  for net in 0..net_count {
    indices.push(bytes.len() as u32);
    /*
    indices.push(streams[net as usize].len() as u32);
    for val in &streams[net as usize] {
      bytes.push(*val as u8);
    }
    */
    //bytes.extend((streams[net as usize] as Vec<u8>).iter());
  }

  unsafe { GLOBAL_INDICES = indices; }
  unsafe { GLOBAL_FIRST_SHOOT_THROUGH = first_shoot_through; }
  bytes
}

#[wasm_bindgen]
pub fn get_indices() -> Vec<u32> {
  unsafe { GLOBAL_INDICES.clone() }
}

#[wasm_bindgen]
pub fn get_first_shoot_through() -> i32 {
  unsafe { GLOBAL_FIRST_SHOOT_THROUGH }
}

/*
            /*
        NetState::FloatInvalid => last,
        NetState::FloatLow     => NetState::FloatInvalid,
        NetState::FloatHigh    => NetState::FloatInvalid,
        NetState::BecomingLow  => last,
        NetState::BecomingHigh => last,
        NetState::Low          => NetState::FloatLow,
        NetState::High         => NetState::FloatHigh,
        NetState::ShootThrough => NetState::FloatInvalid,
        */
    //for _ in 0..SUBSTEPS {
    //  for net in &toposort {
    //    for component in &components_by_output_net[*net as usize] {
    //    }
    //  }
    //}
              /*
          let vgs = if is_pfet && streams[drain as usize].last().unwrap() < streams[source as usize].last().unwrap() {
            streams[source as usize].last().unwrap() - streams[gate as usize].last().unwrap()
          } else if !is_pfet && streams[drain as usize].last().unwrap() > streams[source as usize].last().unwrap() {
            streams[gate as usize].last().unwrap() - streams[source as usize].last().unwrap()
          } else {
            0.0
          };
          */
          //let mix_coef = (2.0 * vgs).sqrt();
          //streams[drain][streams[drain].len() - 1] = streams[drain][streams[drain].len() - 1]
*/
