#[derive(Debug)]
pub(super) enum GraphBuildError {
    EmptyNodes,
    EmptyNodePatterns {
        node_id: String,
    },
    InvalidNodeMapping {
        node_id: String,
        raw_pattern: String,
        reason: String,
    },
    EmptyFlowLevel {
        field_path: String,
        level_idx: usize,
    },
    NegationSelectorNotSupported {
        field_path: String,
        selector: String,
    },
    InvalidNodeSelector {
        field_path: String,
        selector: String,
        reason: String,
    },
    InvalidNodeId {
        node_id: String,
    },
    InvalidNodeIdChar {
        node_id: String,
        invalid_char: char,
    },
    PolicyRuleParse {
        index: usize,
        reason: String,
    },
}

impl GraphBuildError {
    pub(super) fn message(&self) -> String {
        match self {
            GraphBuildError::EmptyNodes => "`nodes` must be a non-empty object".to_string(),
            GraphBuildError::EmptyNodePatterns { node_id } => {
                format!("node {:?} must contain at least one path pattern", node_id)
            }
            GraphBuildError::InvalidNodeMapping {
                node_id,
                raw_pattern,
                reason,
            } => format!("invalid node mapping {:?} -> {:?}: {reason}", node_id, raw_pattern),
            GraphBuildError::EmptyFlowLevel {
                field_path,
                level_idx,
            } => format!("{field_path}[{level_idx}] must not be empty"),
            GraphBuildError::NegationSelectorNotSupported { field_path, selector } => format!(
                "{field_path} does not support negation selector {:?} in graph topology; use rules instead",
                selector
            ),
            GraphBuildError::InvalidNodeSelector {
                field_path,
                selector,
                reason,
            } => format!("{field_path} has invalid node selector {:?}: {reason}", selector),
            GraphBuildError::InvalidNodeId { node_id } => {
                format!("node key {:?} must start with `@`", node_id)
            }
            GraphBuildError::InvalidNodeIdChar {
                node_id,
                invalid_char,
            } => format!("node key {:?} contains invalid character {:?}", node_id, invalid_char),
            GraphBuildError::PolicyRuleParse { index, reason } => {
                format!("rules[{index}] parse error: {reason}")
            }
        }
    }
}
