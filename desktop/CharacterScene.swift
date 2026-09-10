import AppKit
import SceneKit

enum CompanionPose: String, CaseIterable {
    case idle
    case reading
    case walking
    case resting
    case sleeping

    var title: String {
        switch self {
        case .idle: return "陪着你"
        case .reading: return "读书"
        case .walking: return "逛街"
        case .resting: return "休息"
        case .sleeping: return "睡觉"
        }
    }
}

/// A small, completely procedural SceneKit character intended for a transparent
/// 300 × 350 desktop window.  Every visible piece is geometry, so the figure
/// remains crisp on Retina displays and does not depend on bundled art assets.
final class CharacterScene {
    let scene = SCNScene()
    let camera = SCNNode()
    var pose: CompanionPose = .idle

    private let character = SCNNode()
    private let pelvis = SCNNode()
    private let torso = SCNNode()
    private let head = SCNNode()

    private let leftUpperArm = SCNNode()
    private let leftForearm = SCNNode()
    private let rightUpperArm = SCNNode()
    private let rightForearm = SCNNode()
    private let leftThigh = SCNNode()
    private let leftShin = SCNNode()
    private let rightThigh = SCNNode()
    private let rightShin = SCNNode()

    private let leftEye = SCNNode()
    private let rightEye = SCNNode()
    private let hairTips = SCNNode()

    private let book = SCNNode()
    private let shoppingBag = SCNNode()
    private let chair = SCNNode()
    private let sleepCushion = SCNNode()

    private var poseRevision = 0
    private var hasAppliedPose = false

    // MARK: - Palette

    private lazy var skin = material(
        NSColor(calibratedRed: 0.96, green: 0.72, blue: 0.61, alpha: 1),
        roughness: 0.72
    )
    private lazy var skinBlush = material(
        NSColor(calibratedRed: 0.96, green: 0.47, blue: 0.48, alpha: 0.66),
        roughness: 0.8
    )
    private lazy var hair = material(
        NSColor(calibratedRed: 0.105, green: 0.075, blue: 0.095, alpha: 1),
        roughness: 0.4,
        specular: NSColor(calibratedWhite: 0.45, alpha: 1)
    )
    private lazy var hairHighlight = material(
        NSColor(calibratedRed: 0.22, green: 0.12, blue: 0.17, alpha: 1),
        roughness: 0.36
    )
    private lazy var mint = material(
        NSColor(calibratedRed: 0.43, green: 0.76, blue: 0.68, alpha: 1),
        roughness: 0.63
    )
    private lazy var mintDark = material(
        NSColor(calibratedRed: 0.24, green: 0.57, blue: 0.52, alpha: 1),
        roughness: 0.65
    )
    private lazy var rose = material(
        NSColor(calibratedRed: 0.88, green: 0.43, blue: 0.50, alpha: 1),
        roughness: 0.62
    )
    private lazy var roseDark = material(
        NSColor(calibratedRed: 0.57, green: 0.19, blue: 0.27, alpha: 1),
        roughness: 0.54
    )
    private lazy var cream = material(
        NSColor(calibratedRed: 0.98, green: 0.92, blue: 0.78, alpha: 1),
        roughness: 0.82
    )
    private lazy var eyeDark = material(
        NSColor(calibratedRed: 0.13, green: 0.075, blue: 0.06, alpha: 1),
        roughness: 0.32
    )
    private lazy var shoe = material(
        NSColor(calibratedRed: 0.28, green: 0.16, blue: 0.20, alpha: 1),
        roughness: 0.48
    )
    private lazy var wood = material(
        NSColor(calibratedRed: 0.54, green: 0.31, blue: 0.20, alpha: 1),
        roughness: 0.76
    )

    init() {
        scene.background.contents = NSColor.clear
        buildLightingAndCamera()
        buildCharacter()
        buildProps()
        installAmbientAnimation()
        setPose(.idle, animated: false)
    }

    // MARK: - Public behavior

    func setPose(_ pose: CompanionPose, animated: Bool = true) {
        if hasAppliedPose,
           self.pose == pose,
           rightUpperArm.action(forKey: "greeting") == nil,
           rightForearm.action(forKey: "greeting") == nil {
            return
        }
        self.pose = pose
        hasAppliedPose = true
        poseRevision += 1
        let revision = poseRevision

        stopPoseAnimation()
        character.removeAction(forKey: "greeting")
        head.removeAction(forKey: "greeting-head")

        book.isHidden = pose != .reading
        shoppingBag.isHidden = pose != .walking
        chair.isHidden = pose != .resting
        sleepCushion.isHidden = pose != .sleeping

        if pose == .sleeping {
            leftEye.removeAction(forKey: "ambient-blink")
            rightEye.removeAction(forKey: "ambient-blink")
            leftEye.scale.y = 0.08
            rightEye.scale.y = 0.08
        } else {
            leftEye.scale.y = 1
            rightEye.scale.y = 1
            installBlinkAnimationIfNeeded()
        }

        let duration = animated ? 0.42 : 0.0
        SCNTransaction.begin()
        SCNTransaction.animationDuration = duration
        SCNTransaction.animationTimingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        applyPose(pose)
        SCNTransaction.commit()

        let beginLoops = { [weak self] in
            guard let self, self.poseRevision == revision else { return }
            self.startPoseAnimation(pose)
        }
        if duration > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: beginLoops)
        } else {
            beginLoops()
        }
    }

    func greet() {
        let rememberedPose = pose
        rightUpperArm.removeAction(forKey: "pose-loop")
        rightForearm.removeAction(forKey: "pose-loop")

        let lift = eased(SCNAction.rotateTo(x: 0.10, y: 0.06, z: -2.55, duration: 0.24))
        let bend = eased(SCNAction.rotateTo(x: 0.05, y: 0, z: -1.15, duration: 0.20))
        let waveOut = eased(SCNAction.rotateTo(x: 0.05, y: 0, z: -0.78, duration: 0.12))
        let waveIn = eased(SCNAction.rotateTo(x: 0.05, y: 0, z: -1.35, duration: 0.12))
        rightUpperArm.runAction(lift, forKey: "greeting")
        rightForearm.runAction(.sequence([
            bend,
            waveOut, waveIn, waveOut, waveIn, waveOut,
            .wait(duration: 0.10)
        ]), forKey: "greeting")

        let nod = SCNAction.sequence([
            eased(.rotateTo(x: 0.13, y: -0.10, z: -0.05, duration: 0.14)),
            eased(.rotateTo(x: -0.05, y: 0.08, z: 0.04, duration: 0.14)),
            eased(.rotateTo(x: 0, y: 0, z: 0, duration: 0.18))
        ])
        head.runAction(nod, forKey: "greeting-head")

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.25) { [weak self] in
            guard let self, self.pose == rememberedPose else { return }
            self.setPose(rememberedPose, animated: true)
        }
    }

    // MARK: - Scene construction

    private func buildLightingAndCamera() {
        camera.name = "camera"
        camera.camera = SCNCamera()
        camera.camera?.usesOrthographicProjection = true
        // SceneKit's orthographic scale is a half-height. 3.8 frames the full
        // standing figure closely while still fitting the wide sleeping pose.
        camera.camera?.orthographicScale = 3.80
        camera.camera?.zNear = 0.1
        camera.camera?.zFar = 100
        camera.position = SCNVector3(0.55, -0.08, 11.5)
        camera.look(at: SCNVector3(0, -0.18, 0), up: SCNVector3(0, 1, 0), localFront: SCNVector3(0, 0, -1))
        scene.rootNode.addChildNode(camera)

        let key = SCNNode()
        key.name = "light.key"
        key.light = SCNLight()
        key.light?.type = .omni
        key.light?.color = NSColor(calibratedRed: 1.0, green: 0.79, blue: 0.65, alpha: 1)
        key.light?.intensity = 650
        key.light?.castsShadow = true
        key.light?.shadowRadius = 8
        key.light?.shadowColor = NSColor(calibratedWhite: 0, alpha: 0.24)
        key.position = SCNVector3(-4.2, 5.8, 7.0)
        scene.rootNode.addChildNode(key)

        let rim = SCNNode()
        rim.name = "light.rim"
        rim.light = SCNLight()
        rim.light?.type = .omni
        rim.light?.color = NSColor(calibratedRed: 0.60, green: 0.86, blue: 1.0, alpha: 1)
        rim.light?.intensity = 175
        rim.position = SCNVector3(4.5, 3.0, -2.8)
        scene.rootNode.addChildNode(rim)

        let ambient = SCNNode()
        ambient.name = "light.ambient"
        ambient.light = SCNLight()
        ambient.light?.type = .ambient
        ambient.light?.color = NSColor(calibratedRed: 0.72, green: 0.67, blue: 0.65, alpha: 1)
        ambient.light?.intensity = 145
        scene.rootNode.addChildNode(ambient)
    }

    private func buildCharacter() {
        character.name = "character"
        character.categoryBitMask = 1
        scene.rootNode.addChildNode(character)

        pelvis.name = "character.pelvis"
        pelvis.position = SCNVector3(0, -0.30, 0)
        character.addChildNode(pelvis)
        pelvis.addChildNode(meshNode(
            SCNSphere(radius: 0.43), material: mintDark, name: "pelvis.mesh",
            scale: SCNVector3(1.0, 0.72, 0.78)
        ))

        buildTorsoAndDress()
        buildHeadAndFace()
        buildArms()
        buildLegs()
    }

    private func buildTorsoAndDress() {
        torso.name = "character.torso"
        torso.position = SCNVector3(0, 0.34, 0)
        character.addChildNode(torso)

        let bodice = meshNode(
            SCNCapsule(capRadius: 0.43, height: 1.35),
            material: mint,
            name: "torso.bodice",
            scale: SCNVector3(1.03, 1.0, 0.72)
        )
        bodice.position.y = 0.36
        torso.addChildNode(bodice)

        // The tapered skirt and contrasting folded panels keep a readable dress
        // silhouette even when the character is viewed at desktop-icon scale.
        let skirt = meshNode(
            SCNCone(topRadius: 0.40, bottomRadius: 0.72, height: 1.22),
            material: mint,
            name: "outfit.skirt"
        )
        skirt.position.y = -0.55
        skirt.scale.z = 0.78
        torso.addChildNode(skirt)

        let panel = meshNode(
            SCNCone(topRadius: 0.16, bottomRadius: 0.30, height: 1.10),
            material: rose,
            name: "outfit.rose-panel",
            scale: SCNVector3(1, 1, 0.28)
        )
        panel.position = SCNVector3(0.28, -0.55, 0.57)
        panel.eulerAngles.z = -0.10
        torso.addChildNode(panel)

        let belt = meshNode(SCNTorus(ringRadius: 0.43, pipeRadius: 0.055), material: roseDark, name: "outfit.belt")
        belt.position.y = -0.01
        belt.scale = SCNVector3(1.0, 0.78, 0.78)
        torso.addChildNode(belt)

        let collar = meshNode(SCTorusSafe(ring: 0.24, pipe: 0.035), material: cream, name: "outfit.collar")
        collar.position = SCNVector3(0, 0.92, 0.35)
        collar.scale.y = 0.72
        collar.eulerAngles.x = .pi / 2
        torso.addChildNode(collar)

        let neck = meshNode(SCNCylinder(radius: 0.18, height: 0.34), material: skin, name: "neck")
        neck.position = SCNVector3(0, 1.10, 0)
        torso.addChildNode(neck)
    }

    private func buildHeadAndFace() {
        head.name = "character.head"
        head.position = SCNVector3(0, 2.18, 0.02)
        character.addChildNode(head)

        let backHair = meshNode(
            SCNSphere(radius: 0.77), material: hair, name: "hair.back",
            scale: SCNVector3(1.04, 1.24, 0.88)
        )
        backHair.position = SCNVector3(0, -0.02, -0.13)
        head.addChildNode(backHair)

        let face = meshNode(
            SCNSphere(radius: 0.67), material: skin, name: "face",
            scale: SCNVector3(0.91, 1.08, 0.86)
        )
        face.position = SCNVector3(0, -0.01, 0.19)
        head.addChildNode(face)

        let leftEar = meshNode(SCNSphere(radius: 0.115), material: skin, name: "face.left-ear", scale: SCNVector3(0.55, 1, 0.50))
        leftEar.position = SCNVector3(-0.64, 0, 0.15)
        head.addChildNode(leftEar)
        let rightEar = leftEar.clone()
        rightEar.name = "face.right-ear"
        rightEar.position.x = 0.64
        head.addChildNode(rightEar)

        addEye(to: leftEye, x: -0.235, name: "face.left-eye")
        addEye(to: rightEye, x: 0.235, name: "face.right-eye")

        let leftBrow = capsule(radius: 0.022, height: 0.25, material: hair, name: "face.left-brow")
        leftBrow.position = SCNVector3(-0.24, 0.26, 0.755)
        leftBrow.eulerAngles.z = .pi / 2 + 0.10
        head.addChildNode(leftBrow)
        let rightBrow = leftBrow.clone()
        rightBrow.name = "face.right-brow"
        rightBrow.position.x = 0.24
        rightBrow.eulerAngles.z = .pi / 2 - 0.10
        head.addChildNode(rightBrow)

        let nose = meshNode(SCNSphere(radius: 0.085), material: skin, name: "face.nose", scale: SCNVector3(0.55, 0.85, 0.68))
        nose.position = SCNVector3(0, -0.005, 0.80)
        head.addChildNode(nose)

        let mouth = capsule(radius: 0.018, height: 0.19, material: roseDark, name: "face.smile")
        mouth.position = SCNVector3(0, -0.245, 0.777)
        mouth.eulerAngles.z = .pi / 2
        mouth.eulerAngles.x = 0.18
        mouth.scale.x = 0.92
        head.addChildNode(mouth)

        for x in [-0.43 as Float, 0.43] {
            let blush = meshNode(SCNSphere(radius: 0.10), material: skinBlush, name: "face.blush", scale: SCNVector3(1.35, 0.52, 0.22))
            blush.position = SCNVector3(x, -0.17, 0.70)
            head.addChildNode(blush)
        }

        // Side locks and an asymmetric fringe make the hair read as flowing,
        // while keeping the eyes unobstructed for the blink animation.
        let leftLock = capsule(radius: 0.16, height: 1.54, material: hair, name: "hair.left-lock")
        leftLock.position = SCNVector3(-0.59, -0.59, -0.01)
        leftLock.eulerAngles.z = -0.13
        head.addChildNode(leftLock)
        let rightLock = capsule(radius: 0.15, height: 1.72, material: hairHighlight, name: "hair.right-lock")
        rightLock.position = SCNVector3(0.57, -0.67, -0.01)
        rightLock.eulerAngles.z = 0.16
        head.addChildNode(rightLock)

        hairTips.name = "hair.flowing-tips"
        hairTips.position = SCNVector3(0, -0.90, -0.09)
        head.addChildNode(hairTips)
        let strands: [(CGFloat, CGFloat, CGFloat)] = [(-0.43, 0.72, -0.15), (0.0, 0.92, 0.03), (0.40, 0.69, 0.17)]
        for (x, length, angle) in strands {
            let strand = capsule(radius: 0.13, height: length, material: x == 0 ? hairHighlight : hair, name: "hair.strand")
            strand.position = SCNVector3(x, -length * 0.34, 0)
            strand.eulerAngles.z = angle
            hairTips.addChildNode(strand)
        }

        let fringePieces: [(CGFloat, CGFloat, CGFloat)] = [(-0.40, -0.46, 0.70), (-0.12, -0.20, 0.63), (0.16, 0.18, 0.56)]
        for (x, angle, length) in fringePieces {
            let fringe = capsule(radius: 0.105, height: length, material: hair, name: "hair.fringe")
            fringe.position = SCNVector3(x, 0.48, 0.55)
            fringe.eulerAngles.z = angle
            head.addChildNode(fringe)
        }
    }

    private func addEye(to eye: SCNNode, x: Float, name: String) {
        eye.name = name
        eye.position = SCNVector3(x, 0.095, 0.748)
        head.addChildNode(eye)

        let white = meshNode(
            SCNSphere(radius: 0.125), material: material(.white, roughness: 0.48),
            name: "\(name).white", scale: SCNVector3(1.15, 0.82, 0.28)
        )
        eye.addChildNode(white)
        let iris = meshNode(SCNSphere(radius: 0.070), material: eyeDark, name: "\(name).iris", scale: SCNVector3(1, 1, 0.25))
        iris.position.z = 0.119
        eye.addChildNode(iris)
        let glint = meshNode(SCNSphere(radius: 0.018), material: material(.white, roughness: 0.2), name: "\(name).glint")
        glint.position = SCNVector3(-0.020, 0.026, 0.143)
        eye.addChildNode(glint)
    }

    private func buildArms() {
        buildArm(
            upper: leftUpperArm, forearm: leftForearm, side: -1,
            upperName: "character.left-upper-arm", lowerName: "character.left-forearm"
        )
        buildArm(
            upper: rightUpperArm, forearm: rightForearm, side: 1,
            upperName: "character.right-upper-arm", lowerName: "character.right-forearm"
        )
    }

    private func buildArm(upper: SCNNode, forearm: SCNNode, side: Float, upperName: String, lowerName: String) {
        upper.name = upperName
        upper.position = SCNVector3(side * 0.59, 1.17, 0)
        character.addChildNode(upper)

        let sleeve = capsule(radius: 0.19, height: 0.49, material: side < 0 ? mint : rose, name: "\(upperName).sleeve")
        sleeve.position.y = -0.18
        upper.addChildNode(sleeve)
        let upperSkin = capsule(radius: 0.145, height: 0.64, material: skin, name: "\(upperName).skin")
        upperSkin.position.y = -0.62
        upper.addChildNode(upperSkin)

        forearm.name = lowerName
        forearm.position = SCNVector3(0, -0.92, 0)
        upper.addChildNode(forearm)
        let elbow = meshNode(SCNSphere(radius: 0.15), material: skin, name: "\(lowerName).elbow", scale: SCNVector3(0.92, 1.03, 0.90))
        forearm.addChildNode(elbow)
        let lowerSkin = capsule(radius: 0.13, height: 0.78, material: skin, name: "\(lowerName).skin")
        lowerSkin.position.y = -0.36
        forearm.addChildNode(lowerSkin)
        let hand = meshNode(SCNSphere(radius: 0.16), material: skin, name: side < 0 ? "character.left-hand" : "character.right-hand", scale: SCNVector3(0.82, 1.10, 0.62))
        hand.position.y = -0.79
        forearm.addChildNode(hand)
    }

    private func buildLegs() {
        buildLeg(thigh: leftThigh, shin: leftShin, side: -1, name: "character.left")
        buildLeg(thigh: rightThigh, shin: rightShin, side: 1, name: "character.right")
    }

    private func buildLeg(thigh: SCNNode, shin: SCNNode, side: Float, name: String) {
        thigh.name = "\(name)-thigh"
        thigh.position = SCNVector3(side * 0.28, -0.65, 0)
        character.addChildNode(thigh)
        let upperLeg = capsule(radius: 0.205, height: 1.30, material: skin, name: "\(name)-thigh.mesh")
        upperLeg.position.y = -0.61
        thigh.addChildNode(upperLeg)

        shin.name = "\(name)-shin"
        shin.position = SCNVector3(0, -1.26, 0)
        thigh.addChildNode(shin)
        let knee = meshNode(SCNSphere(radius: 0.19), material: skin, name: "\(name)-knee", scale: SCNVector3(0.95, 1.04, 0.92))
        shin.addChildNode(knee)
        let lowerLeg = capsule(radius: 0.172, height: 1.30, material: skin, name: "\(name)-shin.mesh")
        lowerLeg.position.y = -0.61
        shin.addChildNode(lowerLeg)

        let ankleStrap = meshNode(SCTorusSafe(ring: 0.13, pipe: 0.025), material: roseDark, name: "\(name)-shoe.strap")
        ankleStrap.position.y = -1.13
        shin.addChildNode(ankleStrap)

        let shoeNode = meshNode(
            SCNBox(width: 0.37, height: 0.22, length: 0.67, chamferRadius: 0.10),
            material: shoe,
            name: "\(name)-shoe",
            scale: SCNVector3(1, 1, 1)
        )
        shoeNode.position = SCNVector3(0, -1.26, 0.15)
        shin.addChildNode(shoeNode)
    }

    private func buildProps() {
        buildBook()
        buildShoppingBag()
        buildChair()
        buildSleepCushion()
    }

    private func buildBook() {
        book.name = "prop.book"
        book.position = SCNVector3(0, 0.55, 0.98)
        book.eulerAngles = SCNVector3(1.08, 0, 0)
        character.addChildNode(book)

        for side: CGFloat in [-1, 1] {
            let pageBlock = meshNode(
                SCNBox(width: 0.58, height: 0.07, length: 0.72, chamferRadius: 0.025),
                material: cream,
                name: side < 0 ? "prop.book.left-pages" : "prop.book.right-pages"
            )
            pageBlock.position.x = side * 0.285
            pageBlock.eulerAngles.z = side * 0.13
            book.addChildNode(pageBlock)
            let cover = meshNode(
                SCNBox(width: 0.61, height: 0.035, length: 0.76, chamferRadius: 0.018),
                material: roseDark,
                name: "prop.book.cover"
            )
            cover.position = SCNVector3(side * 0.29, -0.055, 0)
            cover.eulerAngles.z = side * 0.13
            book.addChildNode(cover)
        }
        let spine = capsule(radius: 0.035, height: 0.73, material: roseDark, name: "prop.book.spine")
        spine.eulerAngles.x = .pi / 2
        spine.position.y = -0.035
        book.addChildNode(spine)
    }

    private func buildShoppingBag() {
        shoppingBag.name = "prop.shopping-bag"
        shoppingBag.position = SCNVector3(0.08, -0.91, 0.02)
        rightForearm.addChildNode(shoppingBag)

        let body = meshNode(
            SCNBox(width: 0.67, height: 0.70, length: 0.30, chamferRadius: 0.055),
            material: rose,
            name: "prop.shopping-bag.body"
        )
        body.position.y = -0.45
        shoppingBag.addChildNode(body)
        let stripe = meshNode(SCNBox(width: 0.69, height: 0.09, length: 0.315, chamferRadius: 0.025), material: cream, name: "prop.shopping-bag.stripe")
        stripe.position = SCNVector3(0, -0.41, 0)
        shoppingBag.addChildNode(stripe)
        let handle = meshNode(SCTorusSafe(ring: 0.23, pipe: 0.025), material: roseDark, name: "prop.shopping-bag.handle")
        handle.position.y = 0.01
        handle.scale.y = 1.20
        handle.eulerAngles.x = .pi / 2
        shoppingBag.addChildNode(handle)
    }

    private func buildChair() {
        chair.name = "prop.chair"
        chair.position = SCNVector3(-0.03, -1.79, -0.56)
        scene.rootNode.addChildNode(chair)

        let seat = meshNode(
            SCNBox(width: 1.56, height: 0.24, length: 1.10, chamferRadius: 0.16),
            material: rose,
            name: "prop.chair.seat"
        )
        chair.addChildNode(seat)
        let back = meshNode(
            SCNBox(width: 1.56, height: 1.50, length: 0.24, chamferRadius: 0.18),
            material: mintDark,
            name: "prop.chair.back"
        )
        back.position = SCNVector3(0, 0.79, -0.52)
        back.eulerAngles.x = -0.10
        chair.addChildNode(back)

        for x: CGFloat in [-0.58, 0.58] {
            let leg = meshNode(SCNCylinder(radius: 0.075, height: 0.88), material: wood, name: "prop.chair.leg")
            leg.position = SCNVector3(x, -0.48, 0.24)
            leg.eulerAngles.z = x * 0.08
            chair.addChildNode(leg)
        }
    }

    private func buildSleepCushion() {
        sleepCushion.name = "prop.sleep-cushion"
        sleepCushion.position = SCNVector3(0, -2.35, -0.55)
        scene.rootNode.addChildNode(sleepCushion)

        let mattress = meshNode(
            SCNBox(width: 6.15, height: 0.42, length: 1.45, chamferRadius: 0.22),
            material: mintDark,
            name: "prop.sleep-cushion.mattress"
        )
        sleepCushion.addChildNode(mattress)
        let pillow = meshNode(
            SCNBox(width: 1.12, height: 0.38, length: 1.18, chamferRadius: 0.26),
            material: cream,
            name: "prop.sleep-cushion.pillow"
        )
        pillow.position = SCNVector3(2.18, 0.36, 0)
        pillow.eulerAngles.z = -0.10
        sleepCushion.addChildNode(pillow)

        let tassel = meshNode(SCNSphere(radius: 0.095), material: rose, name: "prop.sleep-cushion.tassel")
        tassel.position = SCNVector3(-3.06, -0.03, 0.45)
        sleepCushion.addChildNode(tassel)
    }

    // MARK: - Posing

    private func applyPose(_ pose: CompanionPose) {
        // Reset every driven transform first so transitions cannot retain a bend
        // from a previous state.
        character.position = SCNVector3Zero
        character.eulerAngles = SCNVector3Zero
        character.scale = SCNVector3(0.96, 0.96, 0.96)
        pelvis.eulerAngles = SCNVector3Zero
        torso.position = SCNVector3(0, 0.34, 0)
        torso.eulerAngles = SCNVector3Zero
        torso.scale = SCNVector3(1, 1, 1)
        head.eulerAngles = SCNVector3Zero
        book.position = SCNVector3(0, 0.48, 1.00)
        book.eulerAngles = SCNVector3(1.08, 0, 0)
        shoppingBag.eulerAngles = SCNVector3Zero

        setRotation(leftUpperArm, 0, 0, 0.13)
        setRotation(leftForearm, 0, 0, -0.08)
        setRotation(rightUpperArm, 0, 0, -0.13)
        setRotation(rightForearm, 0, 0, 0.08)
        setRotation(leftThigh, 0, 0, -0.025)
        setRotation(leftShin, 0, 0, 0.02)
        setRotation(rightThigh, 0, 0, 0.025)
        setRotation(rightShin, 0, 0, -0.02)

        switch pose {
        case .idle:
            character.position = SCNVector3(0, 0.20, 0)
            pelvis.eulerAngles.z = -0.025
            torso.eulerAngles.z = 0.035
            head.eulerAngles = SCNVector3(-0.025, -0.10, -0.035)
            setRotation(leftUpperArm, -0.06, 0, 0.18)
            setRotation(rightUpperArm, 0.05, 0, -0.22)
            setRotation(rightForearm, 0.02, 0, 0.12)
            setRotation(leftThigh, 0, 0, -0.035)
            setRotation(rightThigh, 0.02, 0, 0.09)
            setRotation(rightShin, -0.03, 0, -0.08)

        case .reading:
            character.position = SCNVector3(0, 0.20, 0)
            torso.eulerAngles.x = 0.055
            head.eulerAngles = SCNVector3(0.20, 0, 0)
            setRotation(leftUpperArm, -0.42, 0.02, 0.66)
            setRotation(rightUpperArm, -0.42, -0.02, -0.66)
            setRotation(leftForearm, -1.06, 0, -0.10)
            setRotation(rightForearm, -1.06, 0, 0.10)
            book.position = SCNVector3(0, 0.48, 1.02)

        case .walking:
            character.position = SCNVector3(0, 0.24, 0)
            character.eulerAngles.y = -0.07
            torso.eulerAngles.z = -0.035
            head.eulerAngles = SCNVector3(-0.02, 0.12, 0.025)
            setRotation(leftUpperArm, -0.38, 0, 0.11)
            setRotation(rightUpperArm, 0.40, 0, -0.12)
            setRotation(leftThigh, 0.38, 0, -0.03)
            setRotation(leftShin, -0.28, 0, 0)
            setRotation(rightThigh, -0.34, 0, 0.03)
            setRotation(rightShin, 0.44, 0, 0)

        case .resting:
            character.position = SCNVector3(0, -0.87, 0)
            character.eulerAngles.y = -0.08
            torso.eulerAngles = SCNVector3(-0.09, 0, -0.025)
            head.eulerAngles = SCNVector3(0.06, -0.16, -0.08)
            setRotation(leftUpperArm, -0.20, 0, 0.46)
            setRotation(leftForearm, -0.62, 0, -0.30)
            setRotation(rightUpperArm, -0.17, 0, -0.48)
            setRotation(rightForearm, -0.62, 0, 0.32)
            setRotation(leftThigh, -1.43, 0, -0.04)
            setRotation(leftShin, 1.30, 0, 0.03)
            setRotation(rightThigh, -1.28, 0, 0.10)
            setRotation(rightShin, 1.17, 0, -0.05)

        case .sleeping:
            character.position = SCNVector3(-0.04, -1.62, 0.06)
            character.eulerAngles = SCNVector3(0.06, -0.10, -.pi / 2)
            character.scale = SCNVector3(0.82, 0.82, 0.82)
            torso.eulerAngles = SCNVector3(0.02, 0, 0.03)
            head.eulerAngles = SCNVector3(0.03, -0.12, -0.10)
            setRotation(leftUpperArm, -0.22, 0, 0.76)
            setRotation(leftForearm, -0.18, 0, -1.14)
            setRotation(rightUpperArm, 0.24, 0, -0.58)
            setRotation(rightForearm, -0.12, 0, 1.04)
            setRotation(leftThigh, 0.08, 0, -0.05)
            setRotation(leftShin, -0.10, 0, 0.03)
            setRotation(rightThigh, -0.20, 0, 0.08)
            setRotation(rightShin, 0.33, 0, -0.07)
        }
    }

    // MARK: - Animation

    private func installAmbientAnimation() {
        installBlinkAnimationIfNeeded()

        let hairSway = steppedLoop(duration: 3.4) { node, phase in
            node.eulerAngles.z = 0.025 * sin(phase * .pi * 2)
            node.eulerAngles.x = 0.014 * cos(phase * .pi * 2)
        }
        hairTips.runAction(hairSway, forKey: "ambient-hair")
    }

    private func installBlinkAnimationIfNeeded() {
        guard leftEye.action(forKey: "ambient-blink") == nil else { return }
        let blink = SCNAction.repeatForever(SCNAction.sequence([
            .wait(duration: 2.65),
            scaleY(from: 1.0, to: 0.08, duration: 0.065),
            scaleY(from: 0.08, to: 1.0, duration: 0.085),
            .wait(duration: 1.35),
            scaleY(from: 1.0, to: 0.08, duration: 0.055),
            scaleY(from: 0.08, to: 1.0, duration: 0.075),
            .wait(duration: 3.9)
        ]))
        leftEye.runAction(blink, forKey: "ambient-blink")
        rightEye.runAction(blink.copy() as! SCNAction, forKey: "ambient-blink")
    }

    private func stopPoseAnimation() {
        let animatedNodes = [character, pelvis, torso, head, book, shoppingBag,
                             leftUpperArm, leftForearm, rightUpperArm, rightForearm,
                             leftThigh, leftShin, rightThigh, rightShin]
        for node in animatedNodes {
            node.removeAction(forKey: "pose-loop")
            node.removeAction(forKey: "pose-loop-secondary")
        }
    }

    private func startPoseAnimation(_ pose: CompanionPose) {
        switch pose {
        case .idle:
            torso.runAction(steppedLoop(duration: 3.2) { node, phase in
                node.scale.y = 1 + 0.014 * sin(phase * .pi * 2)
                node.position.y = 0.34 + 0.018 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")
            character.runAction(steppedLoop(duration: 4.2) { node, phase in
                node.position.x = 0.025 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")

        case .reading:
            book.runAction(steppedLoop(duration: 2.8) { node, phase in
                node.eulerAngles.z = 0.025 * sin(phase * .pi * 2)
                node.position.y = 0.48 + 0.018 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")
            head.runAction(steppedLoop(duration: 5.2) { node, phase in
                node.eulerAngles.y = 0.055 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")

        case .walking:
            character.runAction(steppedLoop(duration: 0.78) { node, phase in
                node.position.y = 0.24 + 0.075 * abs(sin(phase * .pi * 2))
                node.eulerAngles.z = -0.035 + 0.018 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")
            shoppingBag.runAction(steppedLoop(duration: 0.78) { node, phase in
                node.eulerAngles.z = 0.12 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")
            let legSwing = steppedLoop(duration: 0.78) { [weak self] _, phase in
                guard let self else { return }
                let wave = sin(phase * .pi * 2)
                self.leftThigh.eulerAngles.x = 0.38 * wave
                self.rightThigh.eulerAngles.x = -0.38 * wave
                self.leftShin.eulerAngles.x = wave < 0 ? -0.50 * wave : -0.08 * wave
                self.rightShin.eulerAngles.x = wave > 0 ? 0.50 * wave : 0.08 * wave
                self.leftUpperArm.eulerAngles.x = -0.34 * wave
                self.rightUpperArm.eulerAngles.x = 0.34 * wave
            }
            pelvis.runAction(legSwing, forKey: "pose-loop")

        case .resting:
            torso.runAction(steppedLoop(duration: 3.7) { node, phase in
                node.eulerAngles.x = -0.09 + 0.018 * sin(phase * .pi * 2)
                node.position.y = 0.34 + 0.014 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")
            head.runAction(steppedLoop(duration: 5.4) { node, phase in
                node.eulerAngles.z = -0.08 + 0.025 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")

        case .sleeping:
            torso.runAction(steppedLoop(duration: 4.6) { node, phase in
                let breath = sin(phase * .pi * 2)
                node.scale.z = 1 + 0.025 * breath
                node.position.y = 0.34 + 0.015 * breath
            }, forKey: "pose-loop")
            head.runAction(steppedLoop(duration: 6.2) { node, phase in
                node.eulerAngles.z = -0.10 + 0.012 * sin(phase * .pi * 2)
            }, forKey: "pose-loop")
        }
    }

    /// Custom actions are quantized to 24 samples per second. This preserves a
    /// gentle, hand-animated cadence without driving a display-link or timer.
    private func steppedLoop(duration: TimeInterval, update: @escaping (SCNNode, CGFloat) -> Void) -> SCNAction {
        let oneCycle = SCNAction.customAction(duration: duration) { node, elapsed in
            let frame = floor(Double(elapsed) * 24.0) / 24.0
            let phase = CGFloat(min(frame / duration, 1.0))
            update(node, phase)
        }
        return .repeatForever(oneCycle)
    }

    private func scaleY(from: CGFloat, to: CGFloat, duration: TimeInterval) -> SCNAction {
        SCNAction.customAction(duration: duration) { node, elapsed in
            let progress = duration > 0 ? min(CGFloat(elapsed) / CGFloat(duration), 1) : 1
            node.scale.y = from + (to - from) * progress
        }
    }

    // MARK: - Geometry helpers

    private func material(
        _ color: NSColor,
        roughness: CGFloat,
        metallic: CGFloat = 0,
        specular: NSColor = NSColor(calibratedWhite: 0.20, alpha: 1)
    ) -> SCNMaterial {
        let result = SCNMaterial()
        result.name = "material.\(color.description)"
        result.lightingModel = .physicallyBased
        result.diffuse.contents = color
        result.roughness.contents = roughness
        result.metalness.contents = metallic
        result.specular.contents = specular
        result.isDoubleSided = true
        return result
    }

    private func meshNode(
        _ geometry: SCNGeometry,
        material: SCNMaterial,
        name: String,
        scale: SCNVector3 = SCNVector3(1, 1, 1)
    ) -> SCNNode {
        geometry.materials = [material]
        let node = SCNNode(geometry: geometry)
        node.name = name
        node.scale = scale
        node.categoryBitMask = 1
        return node
    }

    private func capsule(radius: CGFloat, height: CGFloat, material: SCNMaterial, name: String) -> SCNNode {
        meshNode(SCNCapsule(capRadius: radius, height: height), material: material, name: name)
    }

    private func setRotation(_ node: SCNNode, _ x: Float, _ y: Float, _ z: Float) {
        node.eulerAngles = SCNVector3(x, y, z)
    }

    private func eased(_ action: SCNAction) -> SCNAction {
        action.timingMode = .easeInEaseOut
        return action
    }
}

/// Kept as a function so all torus geometry shares the same higher segment
/// count. SceneKit's default torus is visibly faceted at close Retina scales.
private func SCTorusSafe(ring: CGFloat, pipe: CGFloat) -> SCNTorus {
    let torus = SCNTorus(ringRadius: ring, pipeRadius: pipe)
    torus.ringSegmentCount = 48
    torus.pipeSegmentCount = 16
    return torus
}
