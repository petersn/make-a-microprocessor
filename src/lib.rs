
use std::collections::HashMap;
use std::collections::HashSet;
use std::iter::FromIterator;
use once_cell::sync::OnceCell;
use wasm_bindgen::prelude::*;

const SUBSTEPS: u32 = 1;

#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

static mut GLOBAL_INDICES: Vec<u32> = Vec::new();

type Net = u32;

enum Component {
  Fet { is_pfet: bool, gate: Net, drain: Net, source: Net },
  Signal { pattern: Vec<DriveType>, repeat: bool, net: Net },
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
  WeakLow = 2,
  WeakHigh = 3,
  HighZ = 4,
  ShootThrough = 5,
}

#[derive(Clone, Copy)]
#[repr(u8)]
enum NetState {
  Invalid = 0,
  Low = 1,
  High = 2,
  ShootThrough = 3,
}

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

fn parse_pattern_var(x: &u32) -> DriveType {
  match *x {
    0 => DriveType::Low,
    1 => DriveType::High,
    2 => DriveType::HighZ,
    _ => panic!("Invalid pattern var: {}", *x),
  }
}

#[wasm_bindgen]
pub fn init_panic_hook() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn perform_simulation(description: &[u32], net_count: u32, duration: u32, clock_divider: u32) -> Vec<u8> {
  // We now unpack everything.
  let mut streams: Vec<Vec<NetState>> = Vec::new();
  for _ in 0..net_count {
    streams.push(vec![NetState::Invalid]);
  }
  let mut children: Vec<Vec<Net>> = vec![Vec::new(); net_count as usize];
  let mut components_by_output_net: Vec<Vec<Component>> =
    (0..net_count).into_iter().map(|x| Vec::new()).collect();
  let mut components: Vec<Component> = Vec::new();

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
          children[gate as usize].push(drain);
          children[source as usize].push(drain);
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
        4 => {
          let address_bit_count = description[i + 1];
          let word_size = description[i + 2];
          
          components.push(Component::PullResistor{is_pull_down, net});
        }
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

  // Toposort the components.
  /*
  let mut unvisited = HashSet::<Net>::from_iter((0..net_count).into_iter());
  let mut toposort = vec![];
  for start_net in 0..net_count {
    let mut stack = vec![start_net];
    while let Some(net) = stack.pop() {
      if unvisited.contains(&net) {
        toposort.push(net);
        unvisited.remove(&net);
        for child in &children[net as usize] {
          stack.push(*child);
        }
      }
    }
  }
  //toposort.reverse();
  */

  let mut drives = vec![DriveType::HighZ; net_count as usize];

  for t in 0..duration {
    let now = (t / clock_divider) as usize;

    for net in 0..net_count {
      drives[net as usize] = DriveType::HighZ;
    }

    for component in &components {
      match component {
        Component::Fet{is_pfet, gate, drain, source} => {
          let gate_state   = streams[*gate   as usize][t as usize];
          let drain_state  = streams[*drain  as usize][t as usize];
          let source_state = streams[*source as usize][t as usize];
          match (*is_pfet, gate_state, source_state) {
            // Normal operation of nfets and pfets.
            (false, NetState::High, NetState::Low) =>
              drives[*drain as usize] = merge_drives(drives[*drain as usize], DriveType::Low),
            (true, NetState::Low, NetState::High) =>
              drives[*drain as usize] = merge_drives(drives[*drain as usize], DriveType::High),
            // In all other cases we don't drive.
            _ => (),
          }
        }
        Component::PullResistor{ is_pull_down, net } =>
          drives[*net as usize] = merge_drives(drives[*net as usize], match is_pull_down {
            true => DriveType ::WeakLow,
            false => DriveType::WeakHigh,
          }),
        Component::Signal{ pattern, repeat, net } => {
          let signal_output = pattern[match repeat {
            true => now % pattern.len(),
            false => std::cmp::min(now, pattern.len() - 1),
          }];
          drives[*net as usize] = merge_drives(drives[*net as usize], signal_output);
        }
      }
    }

    // Produce new values.
    for net in 0..streams.len() {
      let last = streams[net][t as usize];
      streams[net].push(match (last, drives[net]) {
        (NetState::ShootThrough, _) => NetState::ShootThrough,
        (_, DriveType::ShootThrough) => NetState::ShootThrough,
        (_, DriveType::HighZ) |
        (NetState::Low, DriveType::High) |
        (NetState::High, DriveType::Low)
          => NetState::Invalid,
        (NetState::Invalid, DriveType::Low) => NetState::Low,
        (NetState::Invalid, DriveType::High) => NetState::High,
        (NetState::Invalid, DriveType::WeakLow) => NetState::Low,
        (NetState::Invalid, DriveType::WeakHigh) => NetState::High,
        _ => last,
      });
    }
  }

  let mut bytes: Vec<u8> = Vec::new();
  let mut indices: Vec<u32> = Vec::new();

  // Pack up our results.
  for net in 0..net_count {
    indices.push(bytes.len() as u32);
    indices.push(streams[net as usize].len() as u32);
    for val in &streams[net as usize] {
      bytes.push(*val as u8);
    }
    //bytes.extend((streams[net as usize] as Vec<u8>).iter());
  }

  unsafe { GLOBAL_INDICES = indices; }
  bytes
}

#[wasm_bindgen]
pub fn get_indices() -> Vec<u32> {
  unsafe { GLOBAL_INDICES.clone() }
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
