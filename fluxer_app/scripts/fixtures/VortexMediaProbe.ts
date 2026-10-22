// SPDX-License-Identifier: AGPL-3.0-or-later
// This fixture is built only by VortexMediaSmoke; it is never shipped to users.
import {ExternalE2EEKeyProvider, Room, RoomEvent, Track, type RemoteTrack} from 'livekit-client';
import {initializeVortexMediaKey} from '../../src/features/voice/engine/VoiceE2EEKeyProvider';

let room: Room;
let worker: Worker;
const received: RemoteTrack[] = [];
const controls: string[] = [];
const resources: Array<() => void> = [];

const probe = {
  async join(input: {url: string; token: string; key: string}) {
    worker = new Worker('/worker.js', {type: 'module'});
    const keyProvider = new ExternalE2EEKeyProvider();
    room = new Room({encryption: {keyProvider, worker}, adaptiveStream: false, dynacast: false});
    room.on(RoomEvent.DataReceived, data => controls.push(new TextDecoder().decode(data)));
    room.on(RoomEvent.TrackSubscribed, track => {
      received.push(track);
      const element = track.attach();
      element.autoplay = true;
      document.body.appendChild(element);
      void element.play().catch(() => {});
    });
    await initializeVortexMediaKey(room, keyProvider, 'vortex:1:' + input.key);
    await room.setE2EEEnabled(true);
    await room.connect(input.url, input.token);
  },
  async publish() {
    const canvas = document.createElement('canvas');
    canvas.width = 320; canvas.height = 180;
    document.body.appendChild(canvas);
    const context = canvas.getContext('2d')!;
    let frame = 0;
    const draw = setInterval(() => {
      context.fillStyle = frame++ % 2 ? '#805ad5' : '#319795';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, 100);
    const video = canvas.captureStream(10).getVideoTracks()[0]!;
    const audio = new AudioContext();
    await audio.resume();
    const oscillator = audio.createOscillator();
    const gain = audio.createGain(); gain.gain.value = 0.2;
    const destination = audio.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    oscillator.connect(gain).connect(destination); oscillator.start();
    const sound = destination.stream.getAudioTracks()[0]!;
    resources.push(() => {clearInterval(draw); video.stop(); sound.stop(); oscillator.stop(); void audio.close();});
    await room.localParticipant.publishTrack(video, {source: Track.Source.ScreenShare, simulcast: false, videoCodec: 'vp8'});
    await room.localParticipant.publishTrack(sound, {source: Track.Source.ScreenShareAudio, dtx: false});
  },
  async control(value: string) {
    await room.localParticipant.publishData(new TextEncoder().encode(value), {reliable: true, topic: 'vortex.screen-test'});
  },
  async stats() {
    let packets = 0, frames = 0, energy = 0;
    for (const track of received) {
      const report = await track.receiver?.getStats();
      report?.forEach(entry => {
        if (entry.type === 'inbound-rtp') {
          packets += entry.packetsReceived || 0;
          frames += entry.framesDecoded || 0;
          energy += entry.totalAudioEnergy || 0;
        }
      });
    }
    return {packets, frames, energy, controls, sources: received.map(track => track.source), state: room.state};
  },
  async close() {
    resources.splice(0).forEach(close => close());
    await room?.disconnect(); worker?.terminate();
  },
};

Object.assign(window, {probe});
