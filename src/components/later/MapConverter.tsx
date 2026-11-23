import { Scaffold } from '~/components/shell/ui'

// EXTENSION POINT (phase 4): the map converter (BSP/VMF in, Godot scene out) run as a job on a node
// with the `convert` offload kind. Needs tools.run to start a conversion.
export function MapConverter() {
    return (
        <Scaffold title="Map Converter" phase={4} links={[['/tools/maps', 'Map Manager']]}>
            Pick a source map, a target project and a node; the conversion runs as a job and its result lands in the Map Manager.
        </Scaffold>
    )
}
