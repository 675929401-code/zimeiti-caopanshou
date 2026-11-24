import {Upload} from 'lucide-react';

export function WorkspaceRoleUpload({onOpen}: {onOpen: () => void}) {
  return (
    <div className="ca-slot">
      <div className="ca-slot-files">
        <button type="button" className="ca-slot-upload" title="添加角色" onClick={onOpen}>
          <img src="/commerce/director-role-upload.png" alt="" />
          <Upload size={12} />
          <span className="cs-upload-caption">添加角色</span>
        </button>
      </div>
      <span>添加角色（可选）</span>
    </div>
  );
}
