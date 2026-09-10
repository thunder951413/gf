import AppKit

enum AttentionGestureDecision: Equatable {
    case scheduleSingle
    case attention
    case cancel
    case none
}

enum DesktopAttentionLevel: String, Equatable {
    case care
    case affection
}

enum DesktopAttentionDisposition: Equatable {
    case start(DesktopAttentionLevel)
    case queuedAffection
}

/// Keeps one active request and one affectionate follow-up, while preserving the
/// user's first care gesture and escalating nearby repeats.
struct DesktopAttentionCoordinator {
    private(set) var lastDouble = Date.distantPast
    private(set) var inFlight = false
    private(set) var queuedAffection = false

    mutating func receiveDouble(at now: Date) -> DesktopAttentionDisposition {
        let level: DesktopAttentionLevel = now.timeIntervalSince(lastDouble) <= 60 ? .affection : .care
        lastDouble = now
        if inFlight {
            queuedAffection = true
            return .queuedAffection
        }
        inFlight = true
        return .start(level)
    }

    mutating func complete() -> DesktopAttentionLevel? {
        inFlight = false
        guard queuedAffection else { return nil }
        queuedAffection = false
        inFlight = true
        return .affection
    }

    mutating func cancel() {
        inFlight = false
        queuedAffection = false
    }
}

/// Converts AppKit click counts into intentional desktop interactions. Odd clicks
/// start a new pair; the following even click completes it.
struct AttentionGestureState {
    mutating func mouseUp(clickCount: Int, dragged: Bool) -> AttentionGestureDecision {
        guard !dragged else { return .cancel }
        guard clickCount > 0 else { return .none }
        return clickCount.isMultiple(of: 2) ? .attention : .scheduleSingle
    }

    mutating func cancel() -> AttentionGestureDecision { .cancel }
}

@MainActor
final class DesktopAttentionGestureRouter {
    private var state = AttentionGestureState()
    private var pendingSingle: DispatchWorkItem?
    private let onSingle: () -> Void
    private let onAttention: () -> Void
    private let delay: TimeInterval

    init(delay: TimeInterval = NSEvent.doubleClickInterval, onSingle: @escaping () -> Void, onAttention: @escaping () -> Void) {
        self.delay = delay
        self.onSingle = onSingle
        self.onAttention = onAttention
    }

    func mouseUp(clickCount: Int, dragged: Bool) {
        switch state.mouseUp(clickCount: clickCount, dragged: dragged) {
        case .scheduleSingle:
            pendingSingle?.cancel()
            let work = DispatchWorkItem { [weak self] in
                guard let self else { return }
                self.pendingSingle = nil
                self.onSingle()
            }
            pendingSingle = work
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
        case .attention:
            pendingSingle?.cancel(); pendingSingle = nil; onAttention()
        case .cancel:
            pendingSingle?.cancel(); pendingSingle = nil
        case .none: break
        }
    }

    func cancel() {
        _ = state.cancel()
        pendingSingle?.cancel(); pendingSingle = nil
    }

    func mouseDown(clickCount: Int) {
        if clickCount.isMultiple(of: 2) { cancel() }
    }
}
