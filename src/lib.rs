
use std::collections::HashMap;
use std::collections::HashSet;
use std::iter::FromIterator;
use once_cell::sync::OnceCell;
use wasm_bindgen::prelude::*;

const SUBSTEPS: u32 = 8;

#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

static mut global_indices: Vec<u32> = Vec::new();

type Net = u32;

enum Component {
  Fet { is_pfet: bool, gate: Net, drain: Net, source: Net },
  //Probe { net: Net },
  Signal { pattern: Vec<bool>, repeat: bool, net: Net },
}

#[wasm_bindgen]
pub fn performSimulation(description: &[u32], net_count: u32, duration: u32) -> Vec<f32> {
  // We now unpack everything.
  let mut streams: Vec<Vec<f32>> = Vec::new();
  for _ in 0..net_count {
    streams.push(vec![0.0]);
  }
  let mut children: Vec<Vec<Net>> = vec![Vec::new(); net_count as usize];
  let mut components_by_output_net: Vec<Vec<Component>> =
    (0..net_count).into_iter().map(|x| Vec::new()).collect();
  let mut i: usize = 0;
  while i < description.len() {
    match description[i] {
      1 | 2 => {
        let gate = description[i + 1];
        let drain = description[i + 2];
        let source = description[i + 3];
        components_by_output_net[drain as usize].push(Component::Fet{
          is_pfet: description[i] == 1, gate, drain, source,
        });
        i += 3;
        children[gate as usize].push(drain);
        children[source as usize].push(drain);
      },
      /*
      3 => {
        components.push(Component::Probe{
          net: description[i + 1],
        });
        i += 1;
      },
      */
      6 => {
        let net = description[i + 1];
        let repeat = description[i + 2] != 0;
        let length = description[i + 3];
        let pattern = description[i + 3 .. i + 3 + length as usize].iter().map(|x| *x != 0).collect();
        components_by_output_net[net as usize].push(Component::Signal{pattern, repeat, net});
        i += 3 + length as usize;
      },
      _ => panic!("Deserialization failure"),
    }
    i += 1;
  }

  // Toposort the components.
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

  for t in 0..duration {
    // Save a timestep of values.
    for i in 0..streams.len() {
      let last = *streams[i].last().unwrap();
      streams[i].push(last);
    }

    for _ in 0..SUBSTEPS {
      for net in &toposort {
        for component in &components_by_output_net[*net as usize] {
          match *component {
            Component::Fet{is_pfet, gate, drain, source} => {
              let vgs = if is_pfet && streams[drain as usize].last().unwrap() < streams[source as usize].last().unwrap() {
                streams[source as usize].last().unwrap() - streams[gate as usize].last().unwrap()
              } else if !is_pfet && streams[drain as usize].last().unwrap() > streams[source as usize].last().unwrap() {
                streams[gate as usize].last().unwrap() - streams[source as usize].last().unwrap()
              } else {
                0.0
              };
              let mix_coef = (2.0 * vgs).sqrt();
              streams[drain][streams[drain].len() - 1] = streams[drain][streams[drain].len() - 1]
            },
            Component::Signal{..} => (),
          }
        }
      }
    }
  }

  let mut floats: Vec<f32> = Vec::new();
  let mut indices: Vec<u32> = Vec::new();

  // Pack up our results.
  for net in 0..net_count {
    indices.push(floats.len() as u32);
    floats.extend(streams[net as usize].iter());
  }

  //let mut traces = Vec::new();
  //result.push(1);
  //result.push(2);
  //result.push(3);
  //Some(traces)
  //Some(result)
  unsafe { global_indices = indices; }
  floats
}

#[wasm_bindgen]
pub fn getFloats() -> Vec<u32> {
  unsafe { global_indices.clone() }
}

#[wasm_bindgen]
pub fn generateNumber() -> f64 {
  return 42.0;
}
