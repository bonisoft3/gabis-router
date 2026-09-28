//! Rust implementation corresponding to:
//! - Java class: `btools.router.StdPath`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/StdPath.java`
//! - Java class: `btools.router.OsmPath`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/OsmPath.java`
//!
//! # Summary
//! Path state tracker with 3-state elevation hysteresis buffers, slope cutoffs,
//! turn angle penalties, and kinematic travel time integration.

use crate::dsl::evaluator::WayCostResult;
use super::cost::KinematicConfig;

/// Elevation hysteresis parameters configured globally or by profile.
#[derive(Debug, Clone)]
pub struct ElevationConfig {
    pub penalty_buffer: i32, // default 5.0m in micrometers = 5,000,000
    pub max_buffer: i32,     // default 10.0m in micrometers = 10,000,000
    pub buffer_reduce: i32,  // default 0.0 * 10000 = 0
}

impl Default for ElevationConfig {
    fn default() -> Self {
        Self {
            penalty_buffer: 5_000_000,
            max_buffer: 10_000_000,
            buffer_reduce: 0,
        }
    }
}

/// Dynamic path state carried across road segments along a search path.
#[derive(Debug, Clone, Default)]
pub struct PathState {
    pub ehbd: i32,              // downhill elevation hysteresis buffer in micrometers
    pub ehbu: i32,              // uphill elevation hysteresis buffer in micrometers
    pub elevation_buffer: f32,  // buffer for continuous incline estimation
    pub total_time_s: f64,      // cumulative travel time in seconds
    pub total_energy_j: f64,    // cumulative energy in Joules
}

/// Turn crossing cost configuration for junctions with `estimated_crossing_class`.
#[derive(Debug, Clone, Default)]
pub struct CrossingConfig {
    pub consider_crossing: bool,
    pub crossing_prio_h: i32,
    pub crossing_prio_l: i32,
    pub cost_to_left: [i32; 6],
    pub cost_to_right: [i32; 6],
}

impl CrossingConfig {
    pub fn from_profile(profile: &crate::dsl::parser::Profile) -> Self {
        let valid_for_bikes = profile.get_global_var("validForBikes", 0.0) != 0.0;
        let consider_crossing =
            valid_for_bikes && (profile.get_global_var("consider_crossing", 0.0) != 0.0);
        let crossing_prio_h = profile.get_global_var("crossing_Prio_H", 0.0) as i32;
        let crossing_prio_l = profile.get_global_var("crossing_Prio_L", 0.0) as i32;
        let cost_to_left = [
            profile.get_global_var("cost_ToLeft_from_H_class1", 0.0) as i32,
            profile.get_global_var("cost_ToLeft_from_H_class2", 0.0) as i32,
            profile.get_global_var("cost_ToLeft_from_H_class3", 0.0) as i32,
            profile.get_global_var("cost_ToLeft_from_H_class4", 0.0) as i32,
            profile.get_global_var("cost_ToLeft_from_H_class5", 0.0) as i32,
            profile.get_global_var("cost_ToLeft_from_H_class6", 0.0) as i32,
        ];
        let cost_to_right = [
            profile.get_global_var("cost_ToRight_from_H_class1", 0.0) as i32,
            profile.get_global_var("cost_ToRight_from_H_class2", 0.0) as i32,
            profile.get_global_var("cost_ToRight_from_H_class3", 0.0) as i32,
            profile.get_global_var("cost_ToRight_from_H_class4", 0.0) as i32,
            profile.get_global_var("cost_ToRight_from_H_class5", 0.0) as i32,
            profile.get_global_var("cost_ToRight_from_H_class6", 0.0) as i32,
        ];
        Self {
            consider_crossing,
            crossing_prio_h,
            crossing_prio_l,
            cost_to_left,
            cost_to_right,
        }
    }
}

/// Evaluated metrics for a single road sub-segment.
#[derive(Debug, Clone)]
pub struct SectionCost {
    pub section_cost: f64,
    pub section_cost_int: u32,
    pub turn_cost: f64,
    pub elevation_cost: f64,
    pub effective_costfactor: f32,
    pub time_seconds: f64,
    pub energy_joules: f64,
}

pub struct StdPathCalculator;

impl StdPathCalculator {
    /// Computes incline using an exponential decay buffer matching BRouter's `calcIncline`.
    pub fn calc_incline(elevation_buffer: &mut f32, delta_h: f64, dist: f64) -> f64 {
        if dist <= 0.0 {
            return 0.0;
        }
        *elevation_buffer += delta_h as f32;

        let min_delta = 3.0f32;
        let mut shift = 0.0f32;
        if *elevation_buffer > min_delta {
            shift = -min_delta;
        } else if *elevation_buffer < -min_delta {
            shift = min_delta;
        }

        let decay_factor = (-dist / 100.0).exp() as f32;
        let new_buffer = (*elevation_buffer + shift) * decay_factor - shift;
        let incline = ((*elevation_buffer - new_buffer) / dist as f32) as f64;
        *elevation_buffer = new_buffer;
        incline
    }

    /// Evaluates a road segment with turn cost, elevation hysteresis, and kinematics.
    pub fn process_section(
        state: &mut PathState,
        way_cost: &WayCostResult,
        elev_cfg: &ElevationConfig,
        kinematic_cfg: &KinematicConfig,
        dist: f64,
        delta_h: f64,
        cos_angle: f64,
        crossing_penalty: i32,
        is_detail: bool,
    ) -> SectionCost {
        let turncost_base = way_cost.turncost;
        let uphillcutoff = (way_cost.uphillcutoff * 10000.0) as i32;
        let downhillcutoff = (way_cost.downhillcutoff * 10000.0) as i32;
        let uphillmaxslope = (way_cost.uphillmaxslope * 10000.0) as i32;
        let downhillmaxslope = (way_cost.downhillmaxslope * 10000.0) as i32;

        let cfup = way_cost.uphillcostfactor;
        let cfdown = way_cost.downhillcostfactor;
        let cf = way_cost.costfactor;

        let downhillcostdiv = if way_cost.downhillcost > 0.0 {
            (1_000_000.0 / way_cost.downhillcost) as i32
        } else {
            0
        };

        let downhillmaxslopecostdiv = if way_cost.downhillmaxslopecost > 0.0 {
            (1_000_000.0 / way_cost.downhillmaxslopecost) as i32
        } else {
            downhillcostdiv
        };

        let uphillcostdiv = if way_cost.uphillcost > 0.0 {
            (1_000_000.0 / way_cost.uphillcost) as i32
        } else {
            0
        };

        let uphillmaxslopecostdiv = if way_cost.uphillmaxslopecost > 0.0 {
            (1_000_000.0 / way_cost.uphillmaxslopecost) as i32
        } else {
            uphillcostdiv
        };

        let dist_int = (dist.round() as i32).max(1);

        // 1. Turn penalty with crossing cost
        let turn_cost =
            ((1.0 - cos_angle) * turncost_base as f64 + 0.2) as i32 + crossing_penalty;
        let mut section_cost = turn_cost as f64;

        // 2. Elevation penalty with hysteresis buffer
        let delta_h_micros = (1_000_000.0 * delta_h) as i32;
        state.ehbd += -delta_h_micros - dist_int * downhillcutoff;
        state.ehbu += delta_h_micros - dist_int * uphillcutoff;

        let mut downweight = 0.0f32;
        let mut elev_cost = 0.0f64;

        if state.ehbd > elev_cfg.penalty_buffer {
            downweight = 1.0;
            let excess = state.ehbd - elev_cfg.penalty_buffer;
            let mut reduce = dist_int * elev_cfg.buffer_reduce;
            if reduce > excess {
                downweight = excess as f32 / reduce as f32;
                reduce = excess;
            }
            let excess_max = state.ehbd - elev_cfg.max_buffer;
            if reduce < excess_max {
                reduce = excess_max;
            }
            state.ehbd -= reduce;

            if downhillcostdiv > 0 {
                elev_cost +=
                    reduce.min(dist_int * downhillmaxslope) as f64 / downhillcostdiv as f64;
            }
            if downhillmaxslopecostdiv > 0 {
                elev_cost += 0.max(reduce - dist_int * downhillmaxslope) as f64
                    / downhillmaxslopecostdiv as f64;
            }
        } else if state.ehbd < 0 {
            state.ehbd = 0;
        }

        let mut upweight = 0.0f32;
        if state.ehbu > elev_cfg.penalty_buffer {
            upweight = 1.0;
            let excess = state.ehbu - elev_cfg.penalty_buffer;
            let mut reduce = dist_int * elev_cfg.buffer_reduce;
            if reduce > excess {
                upweight = excess as f32 / reduce as f32;
                reduce = excess;
            }
            let excess_max = state.ehbu - elev_cfg.max_buffer;
            if reduce < excess_max {
                reduce = excess_max;
            }
            state.ehbu -= reduce;

            if uphillcostdiv > 0 {
                elev_cost +=
                    reduce.min(dist_int * uphillmaxslope) as f64 / uphillcostdiv as f64;
            }
            if uphillmaxslopecostdiv > 0 {
                elev_cost += 0.max(reduce - dist_int * uphillmaxslope) as f64
                    / uphillmaxslopecostdiv as f64;
            }
        } else if state.ehbu < 0 {
            state.ehbu = 0;
        }

        section_cost += elev_cost;

        // 3. Slope-dependent effective costfactor
        let costfactor =
            cfup * upweight + cf * (1.0 - upweight - downweight) + cfdown * downweight;
        section_cost += dist_int as f64 * costfactor as f64 + 0.5;

        let section_cost_int = (section_cost.max(0.0)) as u32;

        // 4. Kinematics (travel time & energy) - only computed in detail mode matching BRouter
        let (dt, energy) = if is_detail {
            let incline = Self::calc_incline(&mut state.elevation_buffer, delta_h, dist);
            let (speed, energy) = kinematic_cfg.compute_speed_and_energy(
                dist,
                incline,
                way_cost.maxspeed as f64 / 3.6,
            );
            let dt = dist / speed;
            state.total_time_s += dt;
            state.total_energy_j += energy;
            (dt, energy)
        } else {
            (0.0, 0.0)
        };

        SectionCost {
            section_cost,
            section_cost_int,
            turn_cost: turn_cost as f64,
            elevation_cost: elev_cost,
            effective_costfactor: costfactor,
            time_seconds: dt,
            energy_joules: energy,
        }
    }
}
