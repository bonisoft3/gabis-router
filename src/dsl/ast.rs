//! Rust implementation corresponding to:
//! - Java class: `btools.expressions.BExpression`
//! - Java source: `https://github.com/abrensch/brouter/blob/master/brouter-expressions/src/main/java/btools/expressions/BExpression.java`
//!
//! # Summary
//! Abstract syntax tree (AST) nodes and constant folding optimizations for BRouter profiles.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryOp {
    Or,
    And,
    Xor,
    Add,
    Sub,
    Multiply,
    Divide,
    Max,
    Min,
    Equal,
    Greater,
    Lesser,
}

impl BinaryOp {
    pub fn eval(&self, v1: f32, v2: f32) -> f32 {
        match self {
            BinaryOp::Or => {
                if v1 != 0.0 || v2 != 0.0 {
                    1.0
                } else {
                    0.0
                }
            }
            BinaryOp::And => {
                if v1 != 0.0 && v2 != 0.0 {
                    1.0
                } else {
                    0.0
                }
            }
            BinaryOp::Xor => {
                if (v1 != 0.0) ^ (v2 != 0.0) {
                    1.0
                } else {
                    0.0
                }
            }
            BinaryOp::Add => v1 + v2,
            BinaryOp::Sub => v1 - v2,
            BinaryOp::Multiply => v1 * v2,
            BinaryOp::Divide => {
                if v2 == 0.0 {
                    0.0
                } else {
                    v1 / v2
                }
            }
            BinaryOp::Max => v1.max(v2),
            BinaryOp::Min => v1.min(v2),
            BinaryOp::Equal => {
                if (v1 - v2).abs() < f32::EPSILON {
                    1.0
                } else {
                    0.0
                }
            }
            BinaryOp::Greater => {
                if v1 > v2 {
                    1.0
                } else {
                    0.0
                }
            }
            BinaryOp::Lesser => {
                if v1 < v2 {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum BExpr {
    Number(f32),
    Variable(usize),
    ForeignVariable {
        context: String,
        var_name: String,
        var_idx: usize,
    },
    VariableGet(usize),
    Lookup {
        name_idx: usize,
        allowed_values: Vec<i32>,
    },
    Not(Box<BExpr>),
    Binary {
        op: BinaryOp,
        left: Box<BExpr>,
        right: Box<BExpr>,
    },
    Switch {
        cond: Box<BExpr>,
        then_expr: Box<BExpr>,
        else_expr: Box<BExpr>,
    },
    Assign {
        var_idx: usize,
        expr: Box<BExpr>,
    },
}

impl BExpr {
    /// Attempts constant folding and AST simplification matching BExpression.tryCollapse / tryEvaluateConstant.
    pub fn optimize(self) -> Self {
        match self {
            BExpr::Not(e) => {
                let opt = e.optimize();
                if let BExpr::Number(n) = opt {
                    BExpr::Number(if n == 0.0 { 1.0 } else { 0.0 })
                } else {
                    BExpr::Not(Box::new(opt))
                }
            }
            BExpr::Binary { op, left, right } => {
                let opt_l = left.optimize();
                let opt_r = right.optimize();

                // If both are numbers, fold
                if let (BExpr::Number(n1), BExpr::Number(n2)) = (&opt_l, &opt_r) {
                    return BExpr::Number(op.eval(*n1, *n2));
                }

                // Short-circuit / identity simplifications
                match op {
                    BinaryOp::Or => {
                        if let BExpr::Number(n) = opt_l {
                            if n != 0.0 {
                                return BExpr::Number(1.0);
                            }
                            return opt_r;
                        }
                        if let BExpr::Number(n) = opt_r {
                            if n != 0.0 {
                                return BExpr::Number(1.0);
                            }
                            return opt_l;
                        }
                    }
                    BinaryOp::And => {
                        if let BExpr::Number(n) = opt_l {
                            if n == 0.0 {
                                return BExpr::Number(0.0);
                            }
                            return opt_r;
                        }
                        if let BExpr::Number(n) = opt_r {
                            if n == 0.0 {
                                return BExpr::Number(0.0);
                            }
                            return opt_l;
                        }
                    }
                    BinaryOp::Add => {
                        if let BExpr::Number(n) = opt_l {
                            if n == 0.0 {
                                return opt_r;
                            }
                        }
                        if let BExpr::Number(n) = opt_r {
                            if n == 0.0 {
                                return opt_l;
                            }
                        }
                    }
                    _ => {}
                }

                BExpr::Binary {
                    op,
                    left: Box::new(opt_l),
                    right: Box::new(opt_r),
                }
            }
            BExpr::Switch {
                cond,
                then_expr,
                else_expr,
            } => {
                let opt_c = cond.optimize();
                let opt_t = then_expr.optimize();
                let opt_e = else_expr.optimize();

                if let BExpr::Number(c) = opt_c {
                    if c != 0.0 {
                        opt_t
                    } else {
                        opt_e
                    }
                } else {
                    BExpr::Switch {
                        cond: Box::new(opt_c),
                        then_expr: Box::new(opt_t),
                        else_expr: Box::new(opt_e),
                    }
                }
            }
            BExpr::Assign { var_idx, expr } => BExpr::Assign {
                var_idx,
                expr: Box::new(expr.optimize()),
            },
            other => other,
        }
    }
}
