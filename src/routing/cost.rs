//! Rust implementation corresponding to:
//! - Java class: `btools.router.KinematicModel`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/KinematicModel.java`
//! - Java class: `btools.router.KinematicNoCostModel`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-core/src/main/java/btools/router/KinematicNoCostModel.java`
//!
//! # Summary
//! Physics-based kinematics for speed, power, rolling resistance, aerodynamic drag,
//! and travel time computation using Newton-Raphson cubic equation solving.

pub const GRAVITY: f64 = 9.81;

/// Configuration parameters for bicycle or pedestrian kinematics.
#[derive(Debug, Clone)]
pub struct KinematicConfig {
    pub total_mass: f64,     // Total mass (biker + bike + cargo), kg
    pub max_speed: f64,      // Maximum speed limit before braking, m/s
    pub s_c_x: f64,          // Aerodynamic drag coefficient S * C_x
    pub c_r: f64,            // Rolling resistance coefficient
    pub biker_power: f64,    // Sustained biker mechanical power, W
    pub is_foot_mode: bool,
}

impl Default for KinematicConfig {
    fn default() -> Self {
        Self {
            total_mass: 90.0,
            max_speed: 45.0 / 3.6, // 12.5 m/s (~45 km/h)
            s_c_x: 0.5 * 0.45,     // 0.225
            c_r: 0.01,
            biker_power: 100.0,    // 100 W default
            is_foot_mode: false,
        }
    }
}

impl KinematicConfig {
    /// Solves the cubic power-velocity equation: `a * v^3 + c * v = d`
    /// using the Newton-Raphson method matching BRouter's `solveCubic`.
    pub fn solve_cubic(a: f64, c: f64, d: f64) -> f64 {
        let mut v = 8.0;
        let mut finding_start_value = true;
        for _ in 0..10 {
            let y = (a * v * v + c) * v - d;
            if y < 0.1 {
                if finding_start_value {
                    v *= 2.0;
                    continue;
                }
                break;
            }
            finding_start_value = false;
            let y_prime = 3.0 * a * v * v + c;
            if y_prime.abs() < 1e-9 {
                break;
            }
            v -= y / y_prime;
        }
        v
    }

    /// Computes travel speed (m/s) and energy consumption (J) for a road segment.
    pub fn compute_speed_and_energy(
        &self,
        dist: f64,
        incline: f64,
        way_max_speed: f64,
    ) -> (f64, f64) {
        let mut max_speed = self.max_speed;
        if way_max_speed > 0.0 {
            max_speed = max_speed.min(way_max_speed);
        }

        let f_roll = self.total_mass * GRAVITY * (self.c_r + incline);
        let speed = if self.is_foot_mode {
            // Tobler's hiking function
            let v = self.max_speed * (-3.5 * (incline + 0.05).abs()).exp();
            v.min(max_speed)
        } else {
            let v = Self::solve_cubic(self.s_c_x, f_roll, self.biker_power);
            v.min(max_speed).max(1.0)
        };

        // Mechanical energy (only positive energy is counted; braking does not add negative work)
        let energy_force = self.s_c_x * speed * speed + f_roll;
        let energy = if energy_force > 0.0 {
            dist * energy_force
        } else {
            0.0
        };

        (speed, energy)
    }
}
